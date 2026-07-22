// 性能検証テスト用の自動測定。通話ごとに主要な遅延をミリ秒で記録し、
// 通話ログ（SessionLog.metrics）に相乗りさせて GCS に保存する。
//
// 測っているもの（テスト計画書の自動測定項目に対応）:
//   callAnswerDelayMs  … 呼び出し(call:request) → 係員への着信配信(call:incoming)
//   sttFinalDelaysMs   … 発話終了(最後の音声チャンク) → 確定テキスト(stt:final)
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
const lastAudioAt = new Map<string, number>();     // socketId  → 最後に音声が届いた時刻

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
export function noteSttAudio(socketId: string): void {
  lastAudioAt.set(socketId, Date.now());
}
export function noteSttFinal(socketId: string): void {
  const t0 = lastAudioAt.get(socketId);
  if (t0 === undefined) return;
  const sessionId = resolveSessionId(socketId);
  if (!sessionId) return;
  of(sessionId).sttFinalDelaysMs.push(Date.now() - t0);
}
export function clearSttSocket(socketId: string): void {
  lastAudioAt.delete(socketId);
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
