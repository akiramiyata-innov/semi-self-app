"use client";

import { getSharedAudioContext } from "./audioUnlock";

/**
 * 係員の画面で「お客様の生の声」を鳴らすための再生装置（v1.42.0）。
 *
 * お客様の声は音声認識のために 16kHz・16bit のかたまり（0.1秒ごと）でサーバーへ
 * 届いており、これまでは認識に使ったあと捨てていた。同じかたまりを担当係員へも
 * 配り、ここでつなぎ直して鳴らす。**文字起こしの経路には一切手を触れていない**
 * （横からコピーを受け取るだけ）ので、認識・翻訳・読み上げ・記録は従来どおり動く。
 *
 * ★ぶつ切りにしない仕掛け＝少しだけ「貯めてから鳴らす」。届いた順に即座に鳴らすと
 *   通信のわずかな揺らぎのたびに音が切れる。0.25秒ぶんだけ先の時刻に予約していく
 *   ことで、多少の遅れ・早着があっても音はつながって聞こえる。
 */

/** 送られてくる音の細かさ（お客様端末の録音設定と同じ 16kHz モノラル）。 */
const SAMPLE_RATE = 16000;
/** 貯めてから鳴らすまでの余裕。短いと途切れ、長いと会話が遅れて聞こえる。 */
const LEAD_SEC = 0.25;
/** 予約が現在時刻にこれ以上近づいたら途切れかけ → 余裕を取り直す。 */
const MIN_LEAD_SEC = 0.05;
/**
 * 予約がこれ以上先に溜まったら遅れすぎ（通信が詰まって一気に届いた等）→ 追いつく。
 * 放っておくと「お客様が話し終えて何秒も経ってから声が聞こえる」状態になり、
 * かぶせて話す事故を防ぐという本来の目的が失われるため。
 */
const MAX_LEAD_SEC = 1.2;

export class UserAudioPlayer {
  private gain: GainNode | null = null;
  /** 次のかたまりを鳴らし始める時刻（AudioContext の時計）。 */
  private nextAt = 0;
  /** 予約済みでまだ鳴り終わっていない音。止めるときに全部たどる。 */
  private scheduled = new Set<AudioBufferSourceNode>();
  private muted = false;
  /** 鳴らすつもりで受け取った数と、実際に鳴らせた数（下の blocked の判定に使う）。 */
  private received = 0;
  private played = 0;

  /**
   * 「音は届いているのに1つも鳴らせていない」状態か。
   *
   * ★`resume()` は例外を投げずに止まったまま返ることがあり、押した直後の状態確認だけ
   * では見逃すことがある（実際に、クリック直後は running と報告されたのに音が出ない
   * 場合を検証で確認した）。**結果で確かめる**のが確実なので、鳴らせたかどうかを
   * 数えておき、呼び出し側が少し待ってからこれを見て係員に知らせる。
   * v1.34.1 でお客様側に入れた「気づけない穴を塞ぐ」考え方と同じ。
   *
   * 一時停止中（係員のマイクON）と、そもそも音が届いていないとき（お客様のマイクOFF・
   * アバターの読み上げ中）は数を増やさないので、誤って警告することはない。
   */
  get blocked(): boolean {
    return this.received > 0 && this.played === 0;
  }

  /** 届いた 0.1 秒ぶんの音を、前の音に続けて鳴るように予約する。 */
  push(chunk: ArrayBuffer | ArrayBufferView): void {
    if (this.muted) return;
    this.received++;
    const ctx = getSharedAudioContext();
    if (!ctx || ctx.state !== "running") return;
    // socket.io はブラウザへ ArrayBuffer で渡すのが既定だが、環境によっては
    // Uint8Array 等で届くこともあるので、どちらでも読めるようにしておく。
    const pcm = ArrayBuffer.isView(chunk)
      ? new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
      : new Int16Array(chunk, 0, Math.floor(chunk.byteLength / 2));
    if (pcm.length === 0) return;

    const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

    const now = ctx.currentTime;
    if (this.nextAt < now + MIN_LEAD_SEC || this.nextAt > now + MAX_LEAD_SEC) {
      // 途切れかけ（話し始め・無音のあと）か、遅れすぎ。予約済みを片付けて取り直す
      this.stopScheduled();
      this.nextAt = now + LEAD_SEC;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ensureGain(ctx));
    source.onended = () => { this.scheduled.delete(source); };
    source.start(this.nextAt);
    this.scheduled.add(source);
    this.nextAt += buffer.duration;
    this.played++;
  }

  /**
   * 鳴らすのを止める／再開する。
   *
   * ★係員自身のマイクが入っている間は必ず止める。スピーカーから出たお客様の声を
   * 係員のマイクが拾い、それが認識・翻訳されてお客様へ返る「声の回り込み」を防ぐ。
   * 予約済み（最大0.25秒ぶん）もその場で止めて消し残しを作らない。
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    if (muted) this.stopScheduled();
  }

  /** 通話が終わったときの後片付け。 */
  dispose(): void {
    this.stopScheduled();
    try { this.gain?.disconnect(); } catch { /* already gone */ }
    this.gain = null;
  }

  private ensureGain(ctx: AudioContext): GainNode {
    if (!this.gain || this.gain.context !== ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(ctx.destination);
    }
    return this.gain;
  }

  private stopScheduled(): void {
    for (const source of this.scheduled) {
      source.onended = null;
      try { source.stop(); } catch { /* 既に鳴り終わっている */ }
    }
    this.scheduled.clear();
    this.nextAt = 0;
  }
}
