/**
 * 自動シナリオテストの共通設定と安全装置。
 *
 * ★ここに書いてある「安全装置」は絶対に外さないこと。
 *   疑似係員が一般のお客様の呼び出しを取ってしまうと、そのお客様は誰にもつながらない。
 */

/** テスト用の端末名・端末IDの決まり文句。これで始まらないものはテストではない。 */
export const TEST_PREFIX = "test-";

/** 疑似係員が名乗る名前。本番の待機一覧に出るので、ひと目で分かる名前にする。 */
export const AGENT_STAFF_NAME = "【自動試験】応答ロボット";

/** 疑似係員のログインID。実在の係員と混ざらないよう専用の値にする。 */
export const AGENT_STAFF_UID = "auto-test-agent";
export const AGENT_STAFF_EMAIL = "auto-test-agent@example.invalid";

/**
 * 着信に応答してよいかの判定。**疑似係員はこれが true のときしか応答しない。**
 *
 * 担当駅による絞り込み（テスト専用駅だけを担当にする）は一段目の守りだが、
 * サーバー側は「駅の指定が無い呼び出しは全係員に配る」作りになっているため、
 * それだけでは一般の呼び出しが届く可能性が残る（server/socketServer.ts:207）。
 * 端末名で最終判定するこの関数が、最後の砦。
 */
export function isTestCall(call) {
  const name = String(call?.machineName ?? "");
  const id = String(call?.machineId ?? "");
  return name.startsWith(TEST_PREFIX) && id.startsWith(TEST_PREFIX);
}

/** 本番か開発かの宛先。既定は開発（うっかり本番に流さないため）。 */
export function targetUrl() {
  const t = process.env.TEST_TARGET ?? "dev";
  if (t === "prod") return "https://semi-self-app-production.up.railway.app";
  if (t === "dev") return "http://localhost:3001";
  return t; // URL 直指定
}

export function isProd() {
  return targetUrl().includes("railway.app");
}

/** 8言語。コードはアプリの LangCode と、音声認識に渡す BCP-47 の対応表。 */
export const LANGS = [
  { code: "ja", bcp47: "ja-JP", label: "日本語" },
  { code: "en", bcp47: "en-US", label: "英語" },
  { code: "zh", bcp47: "zh-CN", label: "中国語（簡体）" },
  { code: "zh-TW", bcp47: "cmn-Hant-TW", label: "中国語（繁体）" },
  { code: "ko", bcp47: "ko-KR", label: "韓国語" },
  { code: "fr", bcp47: "fr-FR", label: "フランス語" },
  { code: "es", bcp47: "es-ES", label: "スペイン語" },
  { code: "th", bcp47: "th-TH", label: "タイ語" },
];

/** 音声の形（サーバーが待っている形＝16kHz・16bit・モノラル・100ミリ秒ごと）。 */
export const AUDIO = {
  sampleRate: 16000,
  bytesPerSample: 2,
  chunkMs: 100,
  get chunkBytes() {
    return (this.sampleRate * this.bytesPerSample * this.chunkMs) / 1000; // 3200
  },
};

/**
 * 話し終わった後に流す「環境音」を作る。
 *
 * ★本物の端末はマイクを開いたままなので、話し終えても部屋の音が流れ続ける。
 *   音声認識AIはその無音区間を見て「話し終わった」と判断し、確定を返す。
 *   送信をぷつりと止めると判断できず、確定が返らないまま時間切れになる
 *   （2026-08-19 係員側の音声で実際に発生）。
 * ★完全な無音ではなく、音声ファイルの末尾（＝同じ部屋の暗騒音）を繰り返して使う。
 *   完全な無音だと、アプリの無音ゲートの働き方が実際と変わってしまうため。
 */
export function roomTone(pcm, ms) {
  const tail = Math.min(pcm.length, AUDIO.sampleRate * AUDIO.bytesPerSample * 0.3);
  const src = pcm.subarray(pcm.length - tail);
  const need = Math.ceil((AUDIO.sampleRate * AUDIO.bytesPerSample * ms) / 1000);
  const out = Buffer.alloc(need);
  for (let i = 0; i < need; i += src.length) src.copy(out, i, 0, Math.min(src.length, need - i));
  return out;
}

export function now() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

export function log(tag, ...args) {
  console.log(`[${now()}] ${tag}`, ...args);
}
