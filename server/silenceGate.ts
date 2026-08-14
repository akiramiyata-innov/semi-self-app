// 無音ゲート：音声認識モデルの「幻聴」（無音・微小雑音から言葉を創作する既知の癖）対策。
// マイク音声チャンクの音量(RMS)を常時測定し、「人が話したといえる音量」が一定時間
// 観測されていない区間の認識結果を破棄する。実測ログ（[stt-diag]/[stt-gate]）を見て
// しきい値を調整できるよう、判定時の実測値も返す。

/** 発話とみなすチャンクRMSのしきい値（Int16振幅スケール。静かな室内ノイズは概ね100前後、通常発話は500〜3000）。 */
export const SPEECH_RMS = 300;
/**
 * 発話とみなすのに必要な「連続した」しきい値超えチャンク数（1チャンク≒100ms → 2個≒0.2秒）。
 *
 * ★連続であることが重要（2026-08-03 の「みとよし」事故の教訓）。当初は窓内の合計数で
 * 数えていたため、マウスのクリック音のような単発の物音（1チャンクだけ超える・実測RMS
 * 320〜360）が15秒以内にバラバラに2回あるだけで条件を満たし、その区間のモデルの幻聴が
 * 素通りした。人の声は最小の「はい」（小声）でも2チャンク連続で超える（TTS実測）ので、
 * 連続を要求しても発話は締め出されない。
 */
export const MIN_SPEECH_CHUNKS = 2;
/** 発話チャンクを数える時間窓。これより古い発話は「今の確定結果」の根拠にしない。 */
export const SPEECH_WINDOW_MS = 15_000;

/**
 * PCM16チャンク（リトルエンディアン）のRMS音量を返す。
 * Socket.IO の Buffer は大きな受信バッファの一部を指し byteOffset が奇数のことがあり、
 * Int16Array を直接被せると RangeError になるため、オフセットに依存しない読み方をする。
 */
export function chunkRms(chunk: Buffer): number {
  const n = Math.floor(chunk.byteLength / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = chunk.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export interface GateVerdict {
  /** true = 発話あり → 認識結果を採用。false = 無音区間 → 幻聴とみなし破棄。 */
  accept: boolean;
  /** 判定に使った発話チャンク数（時間窓内・連続条件を満たしたものだけ）。 */
  speechChunks: number;
  /** 前回の確定以降に観測した最大RMS（しきい値調整用）。 */
  maxRms: number;
  /** true = 分割確定（同じ音声の続き）とみなし、直前の判定を引き継いだ。 */
  continuation?: boolean;
}

export class SilenceGate {
  private times: number[] = [];
  private maxRms = 0;
  // 現在進行中の「しきい値超えの連続」。MIN_SPEECH_CHUNKS まで続いて初めて発話と
  // 認め、それまでの分をまとめて times へ移す。単発（クリック音等）はここで捨てられる。
  private pending: number[] = [];
  private runQualified = false;
  /**
   * 直前の確定以降に観測した音声チャンク数と、そのときの判定。
   *
   * ★2026-08-14 の基本性能テスト（英語8通話）で判明した取り逃しの対策。chirp_2 は
   * 1つの発話を **2つの確定に分けて返すことがある**（実測: 「…my card just got stuck
   * in the」＋「ticket vending machine and so doesn't come out what should i do」）。
   * onFinal() が窓をリセットするため、後半は音量の根拠を失い speech=0 maxRms=0 で
   * **必ず破棄**されていた。本物の発話11件がこれで消え、英語の発話の約17%が係員に
   * 届いていなかった（Railwayログで全件確認。破棄と直前の採用の間隔は全件0.0秒）。
   *
   * 見分け方＝**音声チャンクが1つも届かないうちに次の確定が来たか**。マイクONの間
   * チャンクは約100msごとに必ず届くので、幻聴が起きる「無音区間」では必ず何チャンクか
   * 観測される（実測: 破棄した本物の幻聴は maxRms=123 と 215＝チャンクは届いていた）。
   * 逆にチャンクが0個なら、それは同じ音声から続けて出た分割確定でしかありえない。
   */
  private chunksSinceFinal = 0;
  private lastVerdict: GateVerdict | null = null;

  /** 音声チャンクを1つ観測するたびに呼ぶ。 */
  onChunk(rms: number, now: number = Date.now()): void {
    this.chunksSinceFinal++;
    if (rms > this.maxRms) this.maxRms = rms;
    if (rms >= SPEECH_RMS) {
      if (this.runQualified) {
        this.times.push(now); // 連続が既に発話と認められている → そのまま数える
      } else {
        this.pending.push(now);
        if (this.pending.length >= MIN_SPEECH_CHUNKS) {
          this.times.push(...this.pending); // 連続が条件に達した → さかのぼって数える
          this.pending = [];
          this.runQualified = true;
        }
      }
    } else {
      // 連続が途切れた。条件に達しなかった分（単発の物音）は発話と数えない
      this.pending = [];
      this.runQualified = false;
    }
    const cutoff = now - SPEECH_WINDOW_MS;
    while (this.times.length > 0 && this.times[0] < cutoff) this.times.shift();
  }

  /** 時間窓内に十分な発話音量があったか（interim の表示可否に使う）。 */
  hasSpeech(now: number = Date.now()): boolean {
    const cutoff = now - SPEECH_WINDOW_MS;
    return this.times.filter((t) => t >= cutoff).length >= MIN_SPEECH_CHUNKS;
  }

  /** 確定結果の採否を判定する。呼ぶと窓はリセットされ、次の発話の計測が始まる。 */
  onFinal(now: number = Date.now()): GateVerdict {
    // 分割確定：前の確定から音声が1チャンクも届いていない＝同じ音声の続き。新たに
    // 音量を観測しようがないので、直前の判定をそのまま引き継ぐ（本物なら本物、
    // 幻聴なら幻聴の続きとして扱う）。窓は前の確定で空になったままにしておく。
    if (this.chunksSinceFinal === 0 && this.lastVerdict) {
      return { ...this.lastVerdict, continuation: true };
    }
    const cutoff = now - SPEECH_WINDOW_MS;
    const speechChunks = this.times.filter((t) => t >= cutoff).length;
    const verdict: GateVerdict = { accept: speechChunks >= MIN_SPEECH_CHUNKS, speechChunks, maxRms: this.maxRms };
    this.times = [];
    this.maxRms = 0;
    this.chunksSinceFinal = 0;
    this.lastVerdict = verdict;
    // pending / runQualified は消さない：話し続けている最中に確定が来た場合、続きの
    // チャンクは同じ発話の一部なので、次の確定に向けてそのまま数え続ける。
    return verdict;
  }

  /** マイク開始時などに計測をやり直す。 */
  reset(): void {
    this.times = [];
    this.maxRms = 0;
    this.pending = [];
    this.runQualified = false;
    this.chunksSinceFinal = 0;
    this.lastVerdict = null;
  }
}
