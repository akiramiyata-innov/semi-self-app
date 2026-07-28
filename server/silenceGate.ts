// 無音ゲート：音声認識モデルの「幻聴」（無音・微小雑音から言葉を創作する既知の癖）対策。
// マイク音声チャンクの音量(RMS)を常時測定し、「人が話したといえる音量」が一定時間
// 観測されていない区間の認識結果を破棄する。実測ログ（[stt-diag]/[stt-gate]）を見て
// しきい値を調整できるよう、判定時の実測値も返す。

/** 発話とみなすチャンクRMSのしきい値（Int16振幅スケール。静かな室内ノイズは概ね100前後、通常発話は500〜3000）。 */
export const SPEECH_RMS = 300;
/** 確定結果を受け入れるのに必要な発話チャンク数（1チャンク≒100ms → 2個≒0.2秒の発話音量）。 */
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
  /** 判定に使った発話チャンク数（時間窓内）。 */
  speechChunks: number;
  /** 前回の確定以降に観測した最大RMS（しきい値調整用）。 */
  maxRms: number;
}

export class SilenceGate {
  private times: number[] = [];
  private maxRms = 0;

  /** 音声チャンクを1つ観測するたびに呼ぶ。 */
  onChunk(rms: number, now: number = Date.now()): void {
    if (rms > this.maxRms) this.maxRms = rms;
    if (rms >= SPEECH_RMS) this.times.push(now);
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
    const cutoff = now - SPEECH_WINDOW_MS;
    const speechChunks = this.times.filter((t) => t >= cutoff).length;
    const verdict: GateVerdict = { accept: speechChunks >= MIN_SPEECH_CHUNKS, speechChunks, maxRms: this.maxRms };
    this.times = [];
    this.maxRms = 0;
    return verdict;
  }

  /** マイク開始時などに計測をやり直す。 */
  reset(): void {
    this.times = [];
    this.maxRms = 0;
  }
}
