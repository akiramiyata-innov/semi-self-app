// 性能検証テスト用の自動測定。通話ごとに主要な遅延をミリ秒で記録し、
// 通話ログ（SessionLog.metrics）に相乗りさせて GCS に保存する。
//
// 測っているもの（テスト計画書の自動測定項目に対応）:
//   callAnswerDelayMs  … 呼び出し(call:request) → 係員への着信配信(call:incoming)
//   sttFinalDelaysMs   … 発話終了(最後に声が聞こえた時刻) → 確定テキスト(stt:final)
//   ttsDelaysMs        … 係員の発話確定(speech:staff) → 音声送出(tts:audio)
//   disconnects        … 通話中の意図しない切断回数
//
// 常時有効。処理は Map の読み書きのみで通話性能に影響しない。ネットワーク往復と
// ブラウザ描画の時間は含まないため、画面に見えるまでの実測はこの値＋α になる。

export interface SessionMetrics {
  /** 呼び出しから係員への着信配信まで（ミリ秒） */
  callAnswerDelayMs?: number;
  /** 発話終了→確定テキストの各回（ミリ秒） */
  sttFinalDelaysMs: number[];
  /** 係員の発話確定→音声送出の各回（ミリ秒） */
  ttsDelaysMs: number[];
  /** 通話中の切断回数 */
  disconnects: number;
}

function empty(): SessionMetrics {
  return { sttFinalDelaysMs: [], ttsDelaysMs: [], disconnects: 0 };
}

const bySession = new Map<string, SessionMetrics>();
const callRequestAt = new Map<string, number>();   // sessionId → 呼び出し時刻
const staffSpeechAt = new Map<string, number>();   // sessionId → 係員の発話確定時刻
const lastSpeechAt = new Map<string, number>();    // socketId  → 最後に「人の声」が観測された時刻

/** socketId から進行中の sessionId を解決する（socketServer が登録する）。 */
let resolveSessionId: (socketId: string) => string | null = () => null;
export function setSessionResolver(fn: (socketId: string) => string | null): void {
  resolveSessionId = fn;
}

function of(sessionId: string): SessionMetrics {
  let m = bySession.get(sessionId);
  if (!m) { m = empty(); bySession.set(sessionId, m); }
  return m;
}

// ── 呼び出し → 着信配信 ────────────────────────────────────────────────────
export function noteCallRequest(sessionId: string): void {
  callRequestAt.set(sessionId, Date.now());
}
export function noteCallIncoming(sessionId: string): void {
  const t0 = callRequestAt.get(sessionId);
  if (t0 === undefined) return;
  callRequestAt.delete(sessionId);
  of(sessionId).callAnswerDelayMs = Date.now() - t0;
}

// ── 発話終了 → 確定テキスト ───────────────────────────────────────────────
// 「発話終了」は**声が聞こえなくなった時刻**で判定する。音声が届いた時刻では測れない：
// ストリーミング時のキオスクは通話中ずっとマイクONのため、お客様が黙っている間も
// 無音の音声データが流れ続け、「最後に音声が届いた時刻」は常に直前になってしまう
// （実態が3秒でも0.2秒と記録される）。無音ゲートが測っているチャンク音量を使い、
// 人の声とみなせる音量だった最後の時刻を発話終了とする。
export function noteSttSpeech(socketId: string): void {
  lastSpeechAt.set(socketId, Date.now());
}
export function noteSttFinal(socketId: string): void {
  const t0 = lastSpeechAt.get(socketId);
  if (t0 === undefined) return; // 声が観測されていない＝測る対象がない
  const sessionId = resolveSessionId(socketId);
  if (!sessionId) return;
  of(sessionId).sttFinalDelaysMs.push(Date.now() - t0);
  // 次の発話を独立して測るため、確定のたびに基準を捨てる
  lastSpeechAt.delete(socketId);
}
export function clearSttSocket(socketId: string): void {
  lastSpeechAt.delete(socketId);
}

// ── 係員の発話確定 → 音声送出 ─────────────────────────────────────────────
export function noteStaffSpeechFinal(sessionId: string): void {
  staffSpeechAt.set(sessionId, Date.now());
}
export function noteTtsSent(sessionId: string): void {
  const t0 = staffSpeechAt.get(sessionId);
  if (t0 === undefined) return;
  staffSpeechAt.delete(sessionId);
  of(sessionId).ttsDelaysMs.push(Date.now() - t0);
}

// ── 切断 ──────────────────────────────────────────────────────────────────
export function noteDisconnect(sessionId: string): void {
  of(sessionId).disconnects++;
}

/** 通話終了時に取り出す（同時に破棄してメモリを残さない）。 */
export function takeMetrics(sessionId: string): SessionMetrics {
  const m = bySession.get(sessionId) ?? empty();
  bySession.delete(sessionId);
  callRequestAt.delete(sessionId);
  staffSpeechAt.delete(sessionId);
  return m;
}
