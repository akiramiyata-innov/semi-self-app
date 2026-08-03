import fs from "fs";
import path from "path";
import { Server, Socket } from "socket.io";
import type { IncomingMessage, ServerResponse } from "http";
import type { Server as HttpServer } from "http";
import { getCached, setCache } from "../lib/translateCache";
import { getLang, getGoogleTranslateLangCode } from "../lib/languages";
import type { LangCode, StaffStatus, CameraId } from "../lib/socketEvents";
import type { TranscriptEntry, SessionLog } from "../lib/types";
import { isGCSEnabled, uploadLog } from "../lib/gcsClient";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import { getAssignmentsFresh } from "../lib/assignmentClient";
import { recordAppError } from "./errorLog";
import type { GlossaryTerm } from "../lib/types";
import { registerSttHandlers } from "./sttStream";
import { verifySessionToken, SESSION_COOKIE_NAME } from "../lib/session";
import type { SessionPayload } from "../lib/session";
import * as metrics from "./metrics";

function getApiKey(): string {
  return process.env.GOOGLE_API_KEY || "";
}

// Pull a single cookie value out of a raw Cookie header (no cookie lib needed).
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

// The verified staff session attached to a socket at connection time (null for
// anonymous kiosk connections). Staff-only events require this to be present.
function getStaffSession(socket: Socket): SessionPayload | null {
  return (socket.data?.session as SessionPayload | null) ?? null;
}

// Log folder date in JST (UTC+9, no DST) so a call at 08:00 JST files under that
// day, not the previous UTC day. Reading tolerates either since listing scans all
// date folders, but new logs should be filed by Japan calendar date.
function jstDateString(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ── Staff presence ────────────────────────────────────────────────────────────
interface StaffRecord {
  socketId: string;
  uid: string;
  name: string;
  status: StaffStatus;
  activeSessionIds: Set<string>;
  assignedStations: string[];
}

const staffMap = new Map<string, StaffRecord>();

function broadcastStaffList(): void {
  const list = Array.from(staffMap.values()).map((s) => ({
    socketId: s.socketId,
    name: s.name,
    status: s.status,
    activeCalls: s.activeSessionIds.size,
  }));
  io.to("call-queue").emit("staff:list", { staff: list });
}

// ── Call state ────────────────────────────────────────────────────────────────
interface CallRecord {
  sessionId: string;
  machineId: string;
  machineName: string;
  userSocketId: string;
  userLang: LangCode;
  stationId: string;
  timestamp: number;
}

interface ActiveSession extends CallRecord {
  staffSocketId: string;
  startedAt: number;
  transcript: TranscriptEntry[];
  /** 係員画面の「お客様発話中」を表示中か。 */
  userSpeaking?: boolean;
  /** 確定テキストが来ないまま表示が残らないようにする保険タイマー。 */
  speakingTimer?: ReturnType<typeof setTimeout>;
  /** アバターが発話中か（キオスクのマイクが自分の声を拾うため、その間は発話中表示を止める）。 */
  avatarSpeaking?: boolean;
  /**
   * お客様の画面に会話のテキストを出しているか。**既定は非表示**（駅の券売機は人が
   * 並ぶ場所で、文字は画面に残るため後ろから読まれやすい）。お客様側・係員側の
   * どちらからでも切り替えられ、**後から操作したほうが必ず勝つ**。
   */
  textVisible: boolean;
}

/** 「お客様発話中」が確定テキストなしで残り続けないようにする上限。 */
const USER_SPEAKING_MAX_MS = 8_000;

const callQueue = new Map<string, CallRecord>();
// 呼び出しの未応答タイムアウト。係員が在席していても誰も応答しない場合、お客様を
// 無期限に待たせないための打ち切り時間（E-2「係員ゼロ」とは別の守り）。
const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? 60_000);
const callTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
function clearCallTimeout(sessionId: string): void {
  const t = callTimeouts.get(sessionId);
  if (t) { clearTimeout(t); callTimeouts.delete(sessionId); }
}
const activeSessions = new Map<string, ActiveSession>();

let io: Server;
let entryCounter = 0;

// ── Log saving ────────────────────────────────────────────────────────────────
async function saveSessionLog(session: ActiveSession): Promise<void> {
  const endedAt = Date.now();
  const log: SessionLog = {
    sessionId: session.sessionId,
    machineId: session.machineId,
    machineName: session.machineName,
    userLang: session.userLang,
    startedAt: session.startedAt,
    endedAt,
    durationSeconds: Math.round((endedAt - session.startedAt) / 1000),
    transcript: session.transcript,
    metrics: metrics.takeMetrics(session.sessionId),
  };
  const date = jstDateString(endedAt);

  if (isGCSEnabled()) {
    // 一時的な失敗（ネットワークの瞬断等）に備えて2秒おいて1回だけ再試行する。
    // それでも保存できなければサーバー内のファイルへ退避し（次のデプロイまでの
    // 一時保管。記録が完全に失われるよりまし）、係員へ知らせる。
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await uploadLog(date, session.sessionId, log);
        console.log(`[log] saved to GCS: logs/${date}/${session.sessionId}.json (${session.transcript.length} entries)${attempt > 1 ? " ※再試行で成功" : ""}`);
        return;
      } catch (e) {
        console.error(`[log] failed to save to GCS (${attempt}回目):`, e);
        if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    try {
      await writeLocalLog(date, session.sessionId, log);
      console.error(`[log] GCSに保存できなかったためサーバー内へ退避した: logs/${date}/${session.sessionId}.json`);
    } catch (e) {
      console.error("[log] 退避のローカル保存にも失敗:", e);
    }
    // 黙って欠けると性能テストの記録が失われるので係員へ知らせる。
    io.to(session.staffSocketId).emit("error:logSave", { sessionId: session.sessionId });
    recordAppError({ type: "logsave", sessionId: session.sessionId, machineName: session.machineName, detail: "GCSへ保存できず（再試行も失敗）。サーバー内へ退避を試みた" });
    return;
  }

  try {
    await writeLocalLog(date, session.sessionId, log);
    console.log(`[log] saved: logs/${date}/${session.sessionId}.json (${session.transcript.length} entries)`);
  } catch (e) {
    console.error("[log] failed to save session log:", e);
    io.to(session.staffSocketId).emit("error:logSave", { sessionId: session.sessionId });
    recordAppError({ type: "logsave", sessionId: session.sessionId, machineName: session.machineName, detail: `通話ログを保存できなかった: ${String(e).slice(0, 120)}` });
  }
}

/** 通話ログをサーバー内のファイルへ書く（開発時の通常保存と、GCS失敗時の退避に共用）。 */
async function writeLocalLog(date: string, sessionId: string, log: SessionLog): Promise<void> {
  const dir = path.join(process.cwd(), "logs", date);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${sessionId}.json`), JSON.stringify(log, null, 2));
}

// ── Staff eligibility ─────────────────────────────────────────────────────────
// A staff is assigned to a station if they have no station restriction (empty list)
// or the station is explicitly in their list. Empty stationId means "no station
// context" and matches everyone.
function isStaffAssignedToStation(staff: StaffRecord, stationId: string): boolean {
  if (!stationId) return true;
  return staff.assignedStations.length === 0 || staff.assignedStations.includes(stationId);
}

// Whether a staff should see/receive this station's incoming call (not away AND
// assigned). Single source of truth reused by call:incoming, the pre-answer
// face-camera preview, and the staff:join queue replay, so a staff never sees or
// receives video for a call outside their station.
function isStaffEligible(staff: StaffRecord, stationId: string): boolean {
  return staff.status !== "away" && isStaffAssignedToStation(staff, stationId);
}

function getEligibleStaffSocketIds(stationId: string): string[] {
  const ids: string[] = [];
  staffMap.forEach((staff) => {
    if (isStaffEligible(staff, stationId)) ids.push(staff.socketId);
  });
  return ids;
}

// ── Staff status helpers ──────────────────────────────────────────────────────
function releaseSession(sessionId: string, staffSocketId: string): void {
  const staff = staffMap.get(staffSocketId);
  if (staff) {
    staff.activeSessionIds.delete(sessionId);
    if (staff.activeSessionIds.size === 0 && staff.status === "busy") {
      staff.status = "available";
    }
  }
}

// ── 切断の記録 ────────────────────────────────────────────────────────────────
/**
 * Socket.IO が渡す切断理由を、管理画面で読める日本語にする。**通信が途絶えたのか
 * 画面を閉じたのかで対処が変わる**ため（前者は回線・電波、後者は操作）。未知の理由は
 * そのまま出す（ライブラリ側の追加に耐える）。
 */
function disconnectReasonJa(reason: string): string {
  switch (reason) {
    case "ping timeout": return "応答が途絶えた（通信断とみられる）";
    case "transport close": return "接続が閉じられた（画面を離れた・通信断）";
    case "transport error": return "通信エラー";
    case "client namespace disconnect": return "端末側から切断";
    case "server namespace disconnect": return "サーバー側から切断";
    case "server shutting down": return "サーバーの停止・再起動";
    default: return reason;
  }
}

// ── 係員画面の「お客様発話中」 ────────────────────────────────────────────────
// 待っている側に相手の様子を伝えるための表示。点灯は音量（実際に声が出ているか）で
// 判断し、消すのは確定テキストが出たとき。マイクのON/OFF状態には依存しない。

/** 表示状態を変えて係員に伝える（変化があったときだけ送る）。 */
function setUserSpeaking(sessionId: string, session: ActiveSession, speaking: boolean): void {
  if (session.speakingTimer) { clearTimeout(session.speakingTimer); session.speakingTimer = undefined; }
  if (session.userSpeaking === speaking) return;
  session.userSpeaking = speaking;
  io.to(session.staffSocketId).emit("user:speaking", { sessionId, speaking });
}

/** 通話終了時にタイマーを止める（残ったタイマーが後から発火しないように）。 */
function clearSpeakingState(session: ActiveSession | undefined): void {
  if (session?.speakingTimer) { clearTimeout(session.speakingTimer); session.speakingTimer = undefined; }
}

/**
 * 声を検知したとき（sttStream から音量判定を受けて呼ばれる）。送り主がお客様か係員かで
 * 相手側の案内に振り分ける。
 */
function noteVoiceActivity(socketId: string): void {
  for (const [sessionId, session] of activeSessions) {
    if (session.userSocketId === socketId) {
      // お客様が話している → 係員画面に「お客様発話中」
      // アバターが話している間は、その声をマイクが拾って誤点灯するため表示しない。
      // （音声認識そのものは止めない：ここで止めるのは表示の判定だけ）
      if (session.avatarSpeaking) return;
      setUserSpeaking(sessionId, session, true);
      // 確定テキストが来ないまま（騒音の誤検知など）残り続けないようにする保険
      session.speakingTimer = setTimeout(() => {
        session.speakingTimer = undefined;
        setUserSpeaking(sessionId, session, false);
      }, USER_SPEAKING_MAX_MS);
      return;
    }
    if (session.staffSocketId === socketId) {
      // 係員が話している → お客様画面に「係員が回答を準備しています」を出し直す。
      // マイクを入れっぱなしで会話が続く場合、マイクONの合図は最初の一度しか出ないため、
      // 2回目以降の返答でも案内が出るようにここで補う。
      io.to(session.userSocketId).emit("staff:composing", { sessionId, active: true });
      return;
    }
  }
}

// ── Google APIs ───────────────────────────────────────────────────────────────
async function translateText(text: string, from: string, to: string): Promise<string> {
  if (from === to) return text;
  const cached = getCached(text, from, to);
  if (cached) return cached;

  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[translate] SKIP (no API key): "${text}" [${from}→${to}]`);
    return text;
  }

  const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: from, target: to, format: "text" }),
  });
  const json = await res.json() as { data?: { translations?: Array<{ translatedText: string }> }; error?: { message: string } };
  if (json.error) {
    console.error(`[translate] API error [${from}→${to}]: ${json.error.message}`);
    throw new Error(`Translation API error: ${json.error.message}`);
  }
  const translated = json.data?.translations?.[0]?.translatedText ?? text;
  console.log(`[translate] "${text}" → "${translated}" [${from}→${to}]`);
  setCache(text, from, to, translated);
  return translated;
}

/**
 * 用語集の照合に使う正規表現。**大文字小文字は区別しない**。
 *
 * 外国語欄に "toneri" と小文字で登録していても、英語の音声認識は固有名詞を "Toneri" と
 * 大文字で書き出すため、区別すると訳語の固定がほとんど効かなかった（実測で確認）。
 * 英数字だけの語は語の区切りでのみ一致させる（"toneri" が "toneriville" に当たらないように）。
 * 日本語などの語は区切りの概念がないのでそのまま一致させる。
 */
function glossaryPattern(src: string): RegExp {
  const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const latinOnly = /^[A-Za-z0-9 .'-]+$/.test(src);
  return latinOnly
    ? new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi")
    : new RegExp(escaped, "gi");
}

async function translateWithGlossary(text: string, fromLang: string, toLang: string): Promise<string> {
  // 用語集が読めなくても翻訳そのものは続ける。音声認識用・音声合成用は以前から
  // 同じ扱いで、ここだけ巻き添えで翻訳全体が失敗していた。
  const terms = await getGlossaryTermsFresh().catch((e) => {
    console.error("[translate] 用語集を読めなかったため、用語集なしで翻訳する:", e);
    return [] as GlossaryTerm[];
  });
  // Replace longer source terms first so a short term (e.g. 東京) can't consume
  // part of a longer one (東京駅) before it gets its own fixed translation.
  const entries = terms
    .map((term: GlossaryTerm) => ({
      src: term[fromLang as keyof GlossaryTerm] as string | undefined,
      tgt: term[toLang as keyof GlossaryTerm] as string | undefined,
    }))
    .filter((e): e is { src: string; tgt: string } => !!e.src && !!e.tgt)
    .sort((a, b) => b.src.length - a.src.length);

  const replacements: Array<{ placeholder: string; target: string }> = [];
  let processed = text;

  entries.forEach(({ src, tgt }, i) => {
    // 目印は Google 翻訳が「訳してしまわない」形にする。以前の `GLOSS0TERM` は
    // 英語→日本語で「グロスオターム」と音訳されたり、単体だと「用語集」と訳されて
    // 差し戻しが失敗していた（実測: 同一文10回中4回）。`[[0]]` は実際に使う
    // 14方向（7言語×双方向）35回で一度も壊れないことを確認済み。
    // 閉じの `]]` があるので `[[1]]` が `[[11]]` の一部に誤マッチすることもない。
    const placeholder = `[[${i}]]`;
    const replaced = processed.replace(glossaryPattern(src), () => placeholder);
    if (replaced !== processed) {
      processed = replaced;
      replacements.push({ placeholder, target: tgt });
    }
  });

  const fromCode = getGoogleTranslateLangCode(fromLang as LangCode);
  const toCode = getGoogleTranslateLangCode(toLang as LangCode);
  let result = await translateText(processed, fromCode, toCode);
  replacements.forEach(({ placeholder, target }) => {
    result = result.split(placeholder).join(target);
  });
  return result;
}

// Chirp3-HD rejects any single sentence longer than ~300 bytes ("This request
// contains sentences that are too long"). Real staff speech comes from STT with
// no sentence-ending punctuation, so it arrives as one long run-on that trips
// this limit. We split the text into pieces safely under the cap, synthesize
// each, and concatenate the MP3 bytes (which decode fine as one stream).
// Each seam adds ~0.4s of silence, so we split as few times as safely possible
// and cut at word-ish boundaries so that pause lands sensibly, not mid-word.
const MAX_TTS_BYTES = 250;

type Script = "kanji" | "hira" | "kata" | "other";
function scriptOf(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x4e00 && c <= 0x9fff) return "kanji";
  if (c >= 0x3040 && c <= 0x309f) return "hira";
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9d)) return "kata";
  return "other";
}

/** Split text into pieces each ≤ MAX_TTS_BYTES, preferring natural breaks. */
function splitForTts(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (Buffer.byteLength(clean) <= MAX_TTS_BYTES) return [clean];

  // Break after sentence/clause punctuation, keeping the delimiter with its piece.
  const units = clean.split(/(?<=[。．！？!?、,\n])/);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { const t = buf.trim(); if (t) chunks.push(t); buf = ""; };

  for (let unit of units) {
    // A punctuation-free unit can exceed the cap. Split it, cutting just before a
    // hiragana→kanji/katakana transition (usually a word start) near the target so
    // the seam pause lands at a word boundary instead of mid-word. Fall back to a
    // plain length cut when no such boundary is in range.
    while (Buffer.byteLength(unit) > MAX_TTS_BYTES) {
      let hardCut = unit.length;
      while (hardCut > 1 && Buffer.byteLength(unit.slice(0, hardCut)) > MAX_TTS_BYTES) hardCut--;
      let cut = hardCut;
      const minCut = Math.floor(hardCut * 0.6);
      for (let i = hardCut; i > minCut; i--) {
        if (scriptOf(unit[i - 1]) === "hira" && (scriptOf(unit[i]) === "kanji" || scriptOf(unit[i]) === "kata")) {
          cut = i;
          break;
        }
      }
      flush();
      chunks.push(unit.slice(0, cut));
      unit = unit.slice(cut);
    }
    if (Buffer.byteLength(buf + unit) > MAX_TTS_BYTES) flush();
    buf += unit;
  }
  flush();
  return chunks;
}

/** Synthesize one piece (already within the length limit). Returns MP3 bytes or null. */
async function synthesizeChunk(text: string, voiceLangCode: string, voiceName: string, apiKey: string, langCode: LangCode): Promise<Buffer | null> {
  try {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: voiceLangCode, name: voiceName },
        // speakingRate 0.96 = a touch slower for clarity in a noisy station;
        // volumeGainDb +2 = a little louder over ambient noise. No `pitch` — the
        // Chirp3-HD voices reject it (returns "does not support pitch").
        audioConfig: { audioEncoding: "MP3", speakingRate: 0.96, volumeGainDb: 2.0 },
      }),
    });
    const json = await res.json() as { audioContent?: string; error?: { message: string } };
    if (json.error) {
      console.error(`[tts] API error [${langCode}]: ${json.error.message}`);
      return null;
    }
    return json.audioContent ? Buffer.from(json.audioContent, "base64") : null;
  } catch (e) {
    console.error(`[tts] fetch error [${langCode}]:`, e);
    return null;
  }
}

/**
 * 話し言葉のつなぎ言葉（フィラー）。意味を持たない4語だけに絞る。
 * 「まあ」「なんか」は意味を持つことがあり（「まあ、大丈夫です」）、「あの」は
 * 単独では指示語なので、伸ばした「あのー」だけを対象にする。
 */
const FILLER_WORDS = ["えっと", "えーと", "ええと", "あのー"];
// 語の内部で反応しないよう、文頭か区切り文字の直後だけを対象にする。
const FILLER_RE = new RegExp(`(^|[。、．，！？!?\\s])(?:${FILLER_WORDS.join("|")})[、，,]?\\s*`, "g");
// 文頭の相づち（「え、」「あ、」）。文中の「え、」は聞き返しの意味を持つので触らない。
const LEAD_AIZUCHI_RE = /(^|[。．！？!?])\s*[えあ][、，,]\s*/g;

/**
 * 読み上げ・翻訳の前に、フィラーを落とす。
 *
 * 係員の発話をそのまま音声にすると、アバターも「えっと」と言う。実際の通話ログでは
 * 一文に4回入っている例もあり、読み上げが不自然に聞こえる主因になっていた。
 * **翻訳より前**に落とすので外国語のお客様にも効く（訳文が "Um, ..." にならない）。
 * 係員画面の表示と通話ログは原文のままにして、係員が言ったことは残す。
 */
export function stripFillers(text: string): string {
  let out = text;
  // 「えっと、えっと、」の連続は1回では消えきらない（境目の1文字を消費するため）。
  for (let i = 0; i < 3; i++) {
    const next = out.replace(FILLER_RE, "$1").replace(LEAD_AIZUCHI_RE, "$1");
    if (next === out) break;
    out = next;
  }
  out = out.replace(/[、，,]\s*(?=[、，,])/g, "").replace(/^[、，,\s]+/, "").trim();
  // 丸ごとフィラーだった発話は、無言で送るより元のまま読むほうがまし。
  return out || text;
}

/**
 * 記号・単位の読み。音声認識は「10°c」「100m」のように記号のまま書き出すので、
 * そのまま読ませると読み方が定まらない。数字が直前にある場合だけ置き換える
 * （英単語の中の m や c に反応させないため）。長い単位から先に見る。
 */
const SYMBOL_RULES: Array<[RegExp, string]> = [
  [/(\d),(?=\d{3}(?!\d))/g, "$1"],                       // 1,200 → 1200（読点として読まれるのを防ぐ）
  [/(\d{1,2}):(\d{2})(?!\d)/g, "$1時$2分"],               // 10:30 → 10時30分
  [/(\d+(?:\.\d+)?)\s*(?:℃|°\s*[cC])/g, "$1度"],          // 10°c / 10℃ → 10度
  [/(\d+(?:\.\d+)?)\s*°(?![a-zA-Z])/g, "$1度"],
  [/(\d+(?:\.\d+)?)\s*km(?![a-zA-Z])/g, "$1キロメートル"],
  [/(\d+(?:\.\d+)?)\s*mm(?![a-zA-Z])/g, "$1ミリメートル"],
  [/(\d+(?:\.\d+)?)\s*cm(?![a-zA-Z])/g, "$1センチメートル"],
  [/(\d+(?:\.\d+)?)\s*kg(?![a-zA-Z])/g, "$1キログラム"],
  [/(\d+(?:\.\d+)?)\s*m(?![a-zA-Z])/g, "$1メートル"],
  [/(\d+(?:\.\d+)?)\s*[%％]/g, "$1パーセント"],
  [/(\d)\s*[〜～~]\s*(?=\d)/g, "$1から"],                  // 3〜5 → 3から5
];

export function normalizeSymbols(text: string): string {
  let out = text;
  for (const [re, to] of SYMBOL_RULES) out = out.replace(re, to);
  return out;
}

/**
 * 区切りが1つも無い発話に読点を入れる。
 *
 * 実際の会話のように続けて話すと、音声認識が句読点ではなく**空白**で区切ることがある
 * （実ログで確認）。そのままだと読み上げが一本調子になるため、空白を読点に置き換える。
 * すでに句読点がある文には触らない。
 *
 * 空白が1つだけの文は対象外にする。「10°c ほど」のように記号のあとに紛れ込んだ
 * 空白であることが多く、そこに読点を入れると「10度、ほど」と不自然になるため。
 * 同じ理由で、助詞・接尾辞で始まる語の前にも読点を入れない。英数字どうしの間
 * （英単語の並び）も、読点にすると細切れになるので空白のまま残す。
 */
const NO_PAUSE_BEFORE = /^(?:ほど|まで|から|など|くらい|ぐらい|ずつ|程度|以上|以内|以下|ほか)/;

export function addPauses(text: string): string {
  if (/[。、．，！？!?]/.test(text)) return text;
  const parts = text.trim().split(/[\s　]+/).filter(Boolean);
  if (parts.length < 3) return text; // 空白1つだけの文は触らない
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const prev = out[out.length - 1];
    const next = parts[i][0];
    const bothLatin = /[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
    const keepFlowing = bothLatin || NO_PAUSE_BEFORE.test(parts[i]);
    out += (keepFlowing ? " " : "、") + parts[i];
  }
  return out + "。";
}

/** 読み上げ・翻訳に渡す文を作る。画面表示と通話ログは元の文のまま。 */
export function toSpokenText(text: string): string {
  return addPauses(normalizeSymbols(stripFillers(text)));
}

/**
 * 読み上げ用に、英字を含む登録語をその「よみ」へ置き換える（画面表示は変えない）。
 *
 * 日本語の読み上げに英大文字が来ると、音声は「ひとつの単語（すいか）」と「頭文字の略語
 * （エスユーアイシーエー）」のどちらで読むか迷う。さらに Chirp3-HD は生成のたびに音声が
 * 変わる（同一テキストで8回中4種類の音声を確認）ため、読み方が回によって揺れてしまう。
 * かなで渡せば迷いようがないので、表示は登録どおり（SUICA）のまま、音声にだけ読みを渡す。
 */
async function toSpeakableJa(text: string): Promise<string> {
  const terms = await getGlossaryTermsFresh().catch(() => [] as GlossaryTerm[]);
  let out = text;
  for (const t of terms) {
    const ja = t.ja?.trim();
    const yomi = t.yomi?.trim();
    if (!ja || !yomi || !/[A-Za-z]/.test(ja)) continue; // 読み方が割れるのは英字を含む語だけ
    const escaped = ja.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 単語の区切りでのみ置換する（語の内部では反応させない）
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi"), yomi);
  }
  return out;
}

/**
 * 音声合成の結果。`ok` は「言われたことを丸ごと音声にできたか」。
 * 長文は分割して合成するため、一部の断片だけ失敗すると **途中が抜けた音声** に
 * なる。無音より気づきにくいので、丸ごと失敗と同じ扱い（ok=false）にする。
 */
interface TtsResult {
  audio: string;
  ok: boolean;
}

async function synthesizeSpeech(text: string, langCode: LangCode): Promise<TtsResult> {
  const lang = getLang(langCode);
  const apiKey = getApiKey();

  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[tts] SKIP (no API key): "${text}" [${langCode}]`);
    return { audio: "", ok: false };
  }

  // Derive the languageCode from the voice name's own locale prefix rather than
  // lang.bcp47. The Chirp3-HD voices are strict: e.g. cmn-CN-Chirp3-HD-Aoede
  // rejects "zh-CN" and demands "cmn-CN". (bcp47 stays "zh-CN" for STT / Web
  // Speech fallback, where that BCP-47 tag is correct.)
  const voiceLangCode = lang.ttsVoice.split("-").slice(0, 2).join("-");

  const chunks = splitForTts(text);
  if (!chunks.length) return { audio: "", ok: false };

  // Synthesize the pieces in parallel, then join the MP3 bytes in order.
  const parts = await Promise.all(chunks.map((c) => synthesizeChunk(c, voiceLangCode, lang.ttsVoice, apiKey, langCode)));
  const buffers = parts.filter((b): b is Buffer => b !== null);
  if (!buffers.length) return { audio: "", ok: false };

  const combined = Buffer.concat(buffers);
  // 1つでも欠けたら「途中が抜けた音声」なので、丸ごと失敗と同じ扱いにする。
  const ok = buffers.length === chunks.length;
  if (!ok) {
    console.error(`[tts] 一部の断片が合成できなかった [${langCode}] ${buffers.length}/${chunks.length} part(s)`);
  }
  console.log(`[tts] synthesized "${text.slice(0, 30)}${text.length > 30 ? "…" : ""}" [${langCode}] in ${chunks.length} part(s) → ${combined.length} bytes`);
  return { audio: combined.toString("base64"), ok };
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Socket server ─────────────────────────────────────────────────────────────
export function initSocketServer(httpServer: HttpServer<typeof IncomingMessage, typeof ServerResponse>): void {
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn("⚠️  [socketServer] GOOGLE_API_KEY is not configured!");
  } else {
    console.log(`✅ [socketServer] GOOGLE_API_KEY 設定済み (${apiKey.slice(0, 8)}...)`);
  }

  io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/socket.io",
  });

  // Attach the verified staff session (from the login cookie) to each socket at
  // connection time. Kiosk (user) connections have no cookie → session stays null;
  // they keep working. Staff-only events below require a non-null session, so an
  // anonymous socket can no longer register as staff, answer calls, or speak as an
  // attendant just by knowing the event names.
  // 自動測定が socketId から通話を特定できるようにする（キオスク側・係員側の双方）。
  metrics.setSessionResolver((socketId) => {
    for (const [sessionId, s] of activeSessions) {
      if (s.userSocketId === socketId || s.staffSocketId === socketId) return sessionId;
    }
    return null;
  });

  io.use(async (socket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
      socket.data.session = token ? await verifySessionToken(token) : null;
    } catch {
      socket.data.session = null;
    }
    next();
  });

  io.on("connection", (socket: Socket) => {

    // ── Streaming STT (real-time, glossary-aware, long-form) ──────────────────
    // 音量から「お客様が話している」ことを検知したら係員画面に知らせる。マイクのON/OFF
    // ではなく実際の声で判定するので、将来キオスクのマイクを常時ONにしても そのまま動く。
    registerSttHandlers(socket, () => noteVoiceActivity(socket.id));

    // ── Staff joins ───────────────────────────────────────────────────────────
    socket.on("staff:join", async (payload?: { name?: string; uid?: string; stationIds?: string[] }) => {
      // Identity comes from the verified login session, not the client payload —
      // otherwise anyone could register as staff (or as someone else) over the socket.
      const session = getStaffSession(socket);
      if (!session) { console.warn(`[staff:join] rejected: unauthenticated socket ${socket.id}`); return; }
      const uid = session.uid;
      const name = (session.name || session.email || "スタッフ").trim();

      // stationIds が直接渡された場合はそれを優先（キャッシュ遅延を回避）。認証済みスタッフが
      // 自分の担当駅を渡すだけなので信頼してよい。未指定ならサーバー側の最新を読む。
      const assignedStations = payload?.stationIds ?? (uid ? await getAssignmentsFresh(uid).catch(() => []) : []);

      // Re-register (handles reconnect or name change)
      const existing = staffMap.get(socket.id);
      staffMap.set(socket.id, {
        socketId: socket.id,
        uid,
        name,
        status: existing?.status ?? "available",
        activeSessionIds: existing?.activeSessionIds ?? new Set(),
        assignedStations,
      });

      // Drop stale presence for the same person. Logging out and back in quickly
      // leaves the previous socket in the map (its disconnect hasn't fired yet),
      // which showed the staff twice in the online list. Keep only this socket.
      if (uid) {
        for (const [sid, rec] of staffMap) {
          if (sid !== socket.id && rec.uid === uid) staffMap.delete(sid);
        }
      }

      socket.join("call-queue");

      // Replay the current queue to this staff — but only calls they are eligible
      // for, so station routing is enforced on reconnect/reload, not just at
      // call:request time.
      const joined = staffMap.get(socket.id);
      callQueue.forEach((call) => {
        if (!joined || !isStaffEligible(joined, call.stationId)) return;
        socket.emit("call:incoming", {
          sessionId: call.sessionId,
          machineId: call.machineId,
          machineName: call.machineName,
          userLang: call.userLang,
          timestamp: call.timestamp,
        });
      });

      broadcastStaffList();
      console.log(`[staff] joined: ${name} (${socket.id})`);
    });

    // ── Staff updates own station assignments ────────────────────────────────
    socket.on("staff:updateStations", (payload: { stationIds: string[] }) => {
      const existing = staffMap.get(socket.id);
      if (!existing) return;
      existing.assignedStations = payload.stationIds ?? [];
      broadcastStaffList();
      console.log(`[staff] stations updated: ${existing.name} → [${existing.assignedStations.join(", ")}]`);
    });

    // ── Staff sets own status ─────────────────────────────────────────────────
    socket.on("staff:setStatus", (payload: { status: "available" | "away" }) => {
      const staff = staffMap.get(socket.id);
      if (!staff) return;
      if (staff.status === "busy" && staff.activeSessionIds.size > 0) return; // can't leave busy while in call
      staff.status = payload.status;
      broadcastStaffList();
    });

    // ── User requests a call ──────────────────────────────────────────────────
    socket.on("call:request", (payload: { machineId: string; machineName: string; userLang?: LangCode; stationId?: string }) => {
      const { stationId } = payload;
      const eligibleStaffSocketIds = getEligibleStaffSocketIds(stationId ?? "");
      if (eligibleStaffSocketIds.length === 0) {
        socket.emit("call:noStaff");
        return;
      }

      const sessionId = generateSessionId();
      const record: CallRecord = {
        sessionId,
        machineId: payload.machineId,
        machineName: payload.machineName,
        userSocketId: socket.id,
        userLang: payload.userLang ?? "ja",
        stationId: stationId ?? "",
        timestamp: Date.now(),
      };
      metrics.noteCallRequest(sessionId);
      callQueue.set(sessionId, record);
      socket.join(`session:${sessionId}`);
      // Let the user client know its sessionId before any answer, so it can tag
      // preview frames (face camera) sent while the call is still ringing.
      socket.emit("call:requested", { sessionId });

      // Notify only eligible staff (matching station or no restriction)
      const incomingPayload = {
        sessionId,
        machineId: payload.machineId,
        machineName: payload.machineName,
        userLang: record.userLang,
        timestamp: record.timestamp,
      };
      eligibleStaffSocketIds.forEach((sid) => {
        io.to(sid).emit("call:incoming", incomingPayload);
      });
      metrics.noteCallIncoming(sessionId);

      // 未応答タイムアウト: 応答・拒否・キャンセル・切断のいずれかで解除される。
      // 発火したら呼び出しを打ち切り、お客様へ「混み合っています」、係員へ通知を出す。
      callTimeouts.set(sessionId, setTimeout(() => {
        callTimeouts.delete(sessionId);
        const pending = callQueue.get(sessionId);
        if (!pending) return; // すでに応答済み等（保険。通常は解除済みでここに来ない）
        callQueue.delete(sessionId);
        io.to(pending.userSocketId).emit("call:timeout", { sessionId });
        io.to("call-queue").emit("call:taken", { sessionId }); // 着信カードを消す
        io.to("call-queue").emit("call:missed", {
          sessionId,
          machineName: pending.machineName,
          timeoutSeconds: Math.round(CALL_TIMEOUT_MS / 1000),
        });
        console.log(`[call] 未応答のため打ち切り: ${pending.machineName} (${sessionId}, ${CALL_TIMEOUT_MS}ms)`);
        recordAppError({ type: "call-timeout", sessionId, machineName: pending.machineName, detail: `${Math.round(CALL_TIMEOUT_MS / 1000)}秒間 応答が無く呼び出しを打ち切った` });
      }, CALL_TIMEOUT_MS));
    });

    // ── Staff answers a call ──────────────────────────────────────────────────
    socket.on("call:answer", async (payload: { sessionId: string }) => {
      // Only an authenticated staff socket may answer (take ownership of) a call.
      if (!getStaffSession(socket)) return;
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);

      if (!record) {
        // Race condition: another staff already answered
        socket.emit("call:alreadyTaken", { sessionId });
        return;
      }

      // Reject answers for stations this staff is not assigned to (guards the brief
      // fail-open window before a reconnecting staff's assignments load). The client
      // rolls back its optimistic session on call:alreadyTaken.
      const answerer = staffMap.get(socket.id);
      if (answerer && !isStaffAssignedToStation(answerer, record.stationId)) {
        socket.emit("call:alreadyTaken", { sessionId });
        return;
      }

      callQueue.delete(sessionId);
      clearCallTimeout(sessionId);
      const session: ActiveSession = {
        ...record,
        staffSocketId: socket.id,
        startedAt: Date.now(),
        transcript: [],
        textVisible: false, // 既定は非表示。通話ごとに必ずこの状態から始まる
      };
      activeSessions.set(sessionId, session);
      socket.join(`session:${sessionId}`);

      // Update staff status to busy
      const staff = staffMap.get(socket.id);
      if (staff) {
        staff.status = "busy";
        staff.activeSessionIds.add(sessionId);
      }

      io.to("call-queue").emit("call:taken", { sessionId });
      io.to(record.userSocketId).emit("call:answered", {
        sessionId,
        staffName: staff?.name ?? "駅員",
      });

      broadcastStaffList();
    });

    // ── Staff rejects a call ──────────────────────────────────────────────────
    socket.on("call:reject", (payload: { sessionId: string }) => {
      // Only an authenticated staff socket may reject/dismiss a queued call.
      if (!getStaffSession(socket)) return;
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);
      if (!record) return;
      callQueue.delete(sessionId);
      clearCallTimeout(sessionId);
      io.to(record.userSocketId).emit("call:rejected", { sessionId });
      io.to("call-queue").emit("call:taken", { sessionId });
    });

    // ── Call ends ─────────────────────────────────────────────────────────────
    socket.on("call:end", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const session = activeSessions.get(sessionId);
      // Only a participant of this session may end it — the owning staff (終了ボタン) or
      // the kiosk user (キャンセルボタン). Blocks a race-losing *other* staff from tearing
      // down someone else's live call, without blocking the legitimate participants.
      if (session && session.staffSocketId !== socket.id && session.userSocketId !== socket.id) return;
      if (session) {
        await saveSessionLog(session);
        releaseSession(sessionId, session.staffSocketId);
      }
      clearSpeakingState(session);
      activeSessions.delete(sessionId);
      callQueue.delete(sessionId);
      clearCallTimeout(sessionId);
      io.to(`session:${sessionId}`).emit("call:ended", { sessionId });
      io.to("call-queue").emit("call:ended", { sessionId }); // Notify all staff to clear the call
      socket.leave(`session:${sessionId}`);
      broadcastStaffList();
    });

    // ── Speech: user → staff ──────────────────────────────────────────────────
    socket.on(
      "speech:user",
      async (payload: { sessionId: string; text: string; lang: LangCode; isFinal: boolean; clientId?: string }) => {
        const { sessionId, text, lang, isFinal, clientId } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;
        // Only the kiosk user of this session may speak as the user — blocks a
        // third party who knows the sessionId from injecting customer messages.
        if (session.userSocketId !== socket.id) return;

        if (lang !== session.userLang) session.userLang = lang;

        let translatedText: string | undefined;
        let translationFailed = false;
        if (isFinal && lang !== "ja") {
          try {
            translatedText = await translateWithGlossary(text, lang, "ja");
          } catch (e) {
            console.error("[speech:user] translation error:", e);
            translationFailed = true;
            recordAppError({ type: "translate", sessionId, machineName: session.machineName, detail: `お客様の発言を翻訳できなかった（${lang}→日本語）: ${String(e).slice(0, 120)}` });
            io.to(session.staffSocketId).emit("error:translation", { sessionId, direction: "userToJa" });
          }
        }

        if (isFinal) {
          // 確定テキストが係員画面に出る＝「お客様発話中」の役目は終わり
          setUserSpeaking(sessionId, session, false);
          session.transcript.push({
            id: `u-${Date.now()}-${entryCounter++}`,
            speaker: "user",
            text,
            translatedText,
            isFinal: true,
            timestamp: Date.now(),
            translationFailed: translationFailed || undefined,
          });
        }

        io.to(session.staffSocketId).emit("speech:user", { sessionId, text, lang, isFinal, translatedText, translationFailed });

        // お客様側に「係員の画面に届いた」ことを返す（キオスクで既読チェックを表示する）。
        // 待っている間の不安（伝わったのか分からない）を解消するための通知。
        if (isFinal && clientId) {
          io.to(session.userSocketId).emit("speech:delivered", { sessionId, clientId });
        }
      }
    );

    // ── アバターの発話中はお客様の発話検知を止める ───────────────────────────
    // キオスクのマイクは声の主を区別できず、スピーカーから出たアバターの声も拾うため、
    // そのままでは「お客様発話中」が誤点灯する。止めるのは表示の判定のみで、
    // 音声認識・無音ゲートの音量測定は通常どおり継続する。
    socket.on("user:avatarSpeaking", (payload: { sessionId: string; speaking: boolean }) => {
      const { sessionId, speaking } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      if (session.userSocketId !== socket.id) return; // 本人のキオスクのみ
      session.avatarSpeaking = !!speaking;
      if (speaking) setUserSpeaking(sessionId, session, false); // 拾った残りを消す
    });

    // ── 係員が回答を準備中（マイクON／入力中）→ お客様に知らせる ────────────────
    socket.on("staff:composing", (payload: { sessionId: string; active: boolean }) => {
      const { sessionId, active } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      // この通話の担当係員のみ送信可（なりすまし防止・v1.16.0の方針に合わせる）
      if (session.staffSocketId !== socket.id) return;
      io.to(session.userSocketId).emit("staff:composing", { sessionId, active: !!active });
    });

    // ── Speech: staff → user ──────────────────────────────────────────────────
    socket.on(
      "speech:staff",
      async (payload: { sessionId: string; text: string; isFinal: boolean; clientId?: string }) => {
        const { sessionId, text, isFinal, clientId } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;
        // Only the staff who owns this session may speak into it — guards against a
        // staff who lost an answer race (or a stale client) leaking audio into the call.
        if (session.staffSocketId !== socket.id) return;

        const userLang = session.userLang;
        let translatedText: string | undefined;
        let audioBase64 = "";
        let tts: TtsResult = { audio: "", ok: false };

        if (isFinal) {
          metrics.noteStaffSpeechFinal(sessionId);
          // 係員はマイクを切っていても、ここから翻訳・音声合成が続く。返答が実際に出るまで
          // お客様側の「回答を準備しています」を出し続ける（お客様の画面が無反応になるのを防ぐ）。
          io.to(session.userSocketId).emit("staff:composing", { sessionId, active: true });
        }

        if (!isFinal) {
          io.to(session.staffSocketId).emit("speech:staff", { sessionId, text, isFinal: false });
          io.to(session.userSocketId).emit("speech:staff", {
            sessionId,
            text: userLang === "ja" ? text : "",
            isFinal: false,
          });
          return;
        }

        let translationFailed = false;
        // 翻訳と読み上げには、つなぎ言葉を落とし記号を読みに直した文を使う。
        // 係員画面の表示と通話ログは原文（text）のままなので、係員が言ったことは残る。
        const spoken = toSpokenText(text);
        if (userLang !== "ja") {
          try {
            translatedText = await translateWithGlossary(spoken, "ja", userLang);
          } catch (e) {
            console.error("[speech:staff] translation error:", e);
            translationFailed = true;
            recordAppError({ type: "translate", sessionId, machineName: session.machineName, detail: `係員の発言を翻訳できなかった（日本語→${userLang}）: ${String(e).slice(0, 120)}` });
            io.to(session.staffSocketId).emit("error:translation", { sessionId, direction: "jaToUser" });
            translatedText = text; // fallback: send Japanese text as-is
          }
          tts = await synthesizeSpeech(translatedText!, userLang);
        } else {
          translatedText = text;
          // 表示は text（登録どおりの SUICA）のまま、音声には読み（すいか）を渡す
          tts = await synthesizeSpeech(await toSpeakableJa(spoken), "ja");
        }
        audioBase64 = tts.audio;

        // 係員画面には日本語の原文に加えて訳文も返す。clientId は係員側が先に表示した
        // 吹き出しを特定するための目印（同じ文言を続けて話しても取り違えない）。
        io.to(session.staffSocketId).emit("speech:staff", {
          sessionId, text, isFinal: true, clientId,
          translatedText: userLang !== "ja" ? translatedText : undefined,
          // 4秒で消えるトーストを見逃しても分かるよう、発言そのものに印を残す。
          translationFailed, voiceFailed: !tts.ok,
        });

        // 音声を丸ごと届けられなかったときは、テキスト非表示の設定であっても
        // この1件だけは文字を出す（音声も文字も無い＝お客様に何も届かない状態を防ぐ）。
        io.to(session.userSocketId).emit("speech:staff", {
          sessionId, text: translatedText, isFinal: true,
          forceShowText: !tts.ok,
        });

        if (audioBase64) {
          io.to(session.userSocketId).emit("tts:audio", { sessionId, audioBase64, lang: userLang });
          metrics.noteTtsSent(sessionId);
        }

        // 係員は自分の発言が普通に表示されるため、音声が届かなかったことに気づけない。
        // 言い直せるように知らせる。partial=途中が抜けた音声が再生された場合。
        if (!tts.ok) {
          const partial = audioBase64.length > 0;
          io.to(session.staffSocketId).emit("error:tts", { sessionId, partial, reason: "synthesis" });
          console.error(`[tts] 音声を届けられなかった session=${sessionId} partial=${partial}`);
          recordAppError({ type: "tts-synthesis", sessionId, machineName: session.machineName, detail: `${partial ? "一部の" : ""}音声を合成できず文字のみ表示: ${text.slice(0, 60)}` });
        }

        session.transcript.push({
          id: `s-${Date.now()}-${entryCounter++}`,
          speaker: "staff",
          text,
          translatedText: userLang !== "ja" ? translatedText : undefined,
          isFinal: true,
          timestamp: Date.now(),
          translationFailed: translationFailed || undefined,
          voiceFailed: !tts.ok || undefined,
        });
      }
    );

    // ── Screen share (staff → user) ───────────────────────────────────────────
    socket.on("screen:share", (payload: { sessionId: string; frameData: string }) => {
      const { sessionId, frameData } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      // Only the staff who owns this session may share their screen into it.
      if (session.staffSocketId !== socket.id) return;
      socket.to(`session:${sessionId}`).emit("screen:share", { sessionId, frameData });
    });

    // ── Camera frame (user → staff) ───────────────────────────────────────────
    socket.on("screen:frame", (payload: { sessionId: string; frameData: string; camera?: CameraId }) => {
      const { sessionId, frameData, camera } = payload;

      const session = activeSessions.get(sessionId);
      if (session) {
        // Only the session's kiosk user may send its camera frames.
        if (session.userSocketId !== socket.id) return;
        io.to(session.staffSocketId).emit("screen:frame", { sessionId, frameData, camera });
        return;
      }

      // Call not yet answered — relay the face-camera preview to every staff
      // member who can see this call's incoming card (same eligibility as call:incoming).
      const pending = callQueue.get(sessionId);
      if (!pending) return;
      // Only the caller may send preview frames for their own pending call.
      if (pending.userSocketId !== socket.id) return;
      getEligibleStaffSocketIds(pending.stationId).forEach((sid) => {
        io.to(sid).emit("screen:frame", { sessionId, frameData, camera });
      });
    });

    // ── Language update ───────────────────────────────────────────────────────
    // お客様が通話中に言語を選び直したとき。これ以降の翻訳先とアバターの声の言語は
    // session.userLang を都度参照しているので、書き換えた時点から新しい言語になる。
    socket.on("session:setLang", (payload: { sessionId: string; lang: LangCode }) => {
      const session = activeSessions.get(payload.sessionId);
      // 本人（このセッションのキオスク）以外からの変更は受け付けない。
      if (!session || session.userSocketId !== socket.id) return;
      if (session.userLang === payload.lang) return;
      session.userLang = payload.lang;
      // 係員画面の言語表示（相手の言語ラベル・訳文の見出し）を追従させる。
      io.to(session.staffSocketId).emit("session:langChanged", {
        sessionId: payload.sessionId,
        lang: payload.lang,
      });
      console.log(`[lang] session=${payload.sessionId} → ${payload.lang}`);
    });

    // ── お客様画面のテキスト表示 ON/OFF ────────────────────────────────────────
    // お客様側・係員側のどちらからでも操作でき、**後から操作したほうが必ず勝つ**。
    // 状態はサーバーが1つだけ持ち、切り替わるたびに両方の画面へ同じ値を配ることで、
    // 二人が同時に押しても最終的に必ず同じ表示になる。
    socket.on("session:setTextVisible", (payload: { sessionId: string; visible: boolean }) => {
      const session = activeSessions.get(payload.sessionId);
      if (!session) return;
      // この通話の当事者（お客様のキオスク or 担当係員）以外は操作できない。
      if (session.userSocketId !== socket.id && session.staffSocketId !== socket.id) return;
      const visible = !!payload.visible;
      if (session.textVisible === visible) return;
      session.textVisible = visible;
      const update = { sessionId: payload.sessionId, visible };
      io.to(session.userSocketId).emit("session:textVisible", update);
      io.to(session.staffSocketId).emit("session:textVisible", update);
      console.log(`[text] session=${payload.sessionId} → ${visible ? "表示" : "非表示"}`);
    });

    // ── お客様の端末で音声を再生できなかった ───────────────────────────────────
    // サーバーは音声を送れているので合成側では検知できない（ブラウザ側の再生・
    // デコード失敗、自動再生のブロック等）。放置すると、お客様には音も文字も届かず、
    // 係員も気づけないため、キオスクから知らせてもらう。
    socket.on("tts:playbackFailed", (payload: { sessionId: string }) => {
      const session = activeSessions.get(payload.sessionId);
      if (!session || session.userSocketId !== socket.id) return;
      io.to(session.staffSocketId).emit("error:tts", {
        sessionId: payload.sessionId,
        partial: false,
        reason: "playback",
      });
      console.error(`[tts] お客様の端末で再生できなかった session=${payload.sessionId}`);
      recordAppError({ type: "tts-playback", sessionId: payload.sessionId, machineName: session.machineName, detail: "お客様の端末で音声を再生できなかった（文字のみ表示）" });
    });

    // ── お客様側のマイク異常 ──────────────────────────────────────────────────
    // 係員からは「呼び出したのに話さないお客様」にしか見えず、マイクの問題だと
    // 気づけないため伝える。code=null は解消の合図。
    socket.on("user:micError", (payload: { sessionId: string; code: string | null }) => {
      const session = activeSessions.get(payload.sessionId);
      if (!session || session.userSocketId !== socket.id) return;
      io.to(session.staffSocketId).emit("user:micError", {
        sessionId: payload.sessionId,
        code: payload.code,
      });
      console.log(`[mic] お客様側のマイク異常 session=${payload.sessionId} code=${payload.code ?? "解消"}`);
      if (payload.code) recordAppError({ type: "mic-user", sessionId: payload.sessionId, machineName: session.machineName, detail: `お客様側のマイク異常: ${payload.code}` });
    });

    // ── Disconnect cleanup ────────────────────────────────────────────────────
    socket.on("disconnect", (reason: string) => {
      // 係員の名前は障害履歴に残すので、staffMap から消す前に控える。
      const staffName = staffMap.get(socket.id)?.name;
      staffMap.delete(socket.id);
      metrics.clearSttSocket(socket.id);

      activeSessions.forEach((session, sessionId) => {
        if (session.staffSocketId === socket.id || session.userSocketId === socket.id) {
          // 通話中の切断＝性能指標。ログ保存より前に記録する（保存時に取り出すため）。
          metrics.noteDisconnect(sessionId);
          // 障害履歴にも残す。画面の通知はその場限りで消えるため、後から
          // 「誰が・どの通話で・通話中だったか」を追えるようにする。
          const who = session.userSocketId === socket.id
            ? "お客様"
            : `係員（${staffName ?? "名前不明"}）`;
          recordAppError({
            type: "disconnect",
            sessionId,
            machineName: session.machineName,
            detail: `通話中に${who}の接続が切れた: ${disconnectReasonJa(reason)}`,
          });
          saveSessionLog(session).catch((e) => console.error("[log] disconnect save error:", e));

          // If user disconnected, free the staff member
          if (session.userSocketId === socket.id) {
            // User disconnected — notify staff
            io.to(session.staffSocketId).emit("call:userDisconnected", {
              sessionId,
              machineName: session.machineName,
            });
            releaseSession(sessionId, session.staffSocketId);
            clearSpeakingState(session);
            activeSessions.delete(sessionId);
            io.to(session.staffSocketId).emit("call:ended", { sessionId });
            io.to("call-queue").emit("call:ended", { sessionId });
          } else {
            // Staff disconnected — notify user with a distinct event (not call:ended)
            io.to(session.userSocketId).emit("call:staffDisconnected", { sessionId });
            releaseSession(sessionId, session.staffSocketId);
            clearSpeakingState(session);
            activeSessions.delete(sessionId);
            io.to("call-queue").emit("call:ended", { sessionId });
          }
        }
      });

      callQueue.forEach((record, sessionId) => {
        if (record.userSocketId === socket.id) {
          // 呼び出し中（まだ誰も応答していない）お客様の切断。通話中の切断とは
          // 意味が違う（応答が遅い・お客様が待ちきれず離れた の手がかりになる）。
          recordAppError({
            type: "disconnect",
            sessionId,
            machineName: record.machineName,
            detail: `呼び出し中（応答前）にお客様の接続が切れた: ${disconnectReasonJa(reason)}`,
          });
          callQueue.delete(sessionId);
          clearCallTimeout(sessionId);
          io.to("call-queue").emit("call:taken", { sessionId });
        }
      });

      broadcastStaffList();
    });
  });
}
