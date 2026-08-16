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
import { recordAppError, recordSocketError, setSocketContextResolver } from "./errorLog";
import { APP_VERSION } from "../lib/appVersion";
import type { GlossaryTerm } from "../lib/types";
import { registerSttHandlers } from "./sttStream";
import { splitForSpeech } from "./ttsSplit";
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
  /**
   * 「お客様発話中」が音量だけでなく認識の実働（途中経過）でも裏付けられたか。
   * 音量だけの点灯は短めに消す（物音の誤点灯を8秒も残さないため）。
   */
  speakingConfirmed?: boolean;
  /** アバターが発話中か（キオスクのマイクが自分の声を拾うため、その間は発話中表示を止める）。 */
  avatarSpeaking?: boolean;
  /**
   * お客様の画面に会話のテキストを出しているか。**既定は非表示**（駅の券売機は人が
   * 並ぶ場所で、文字は画面に残るため後ろから読まれやすい）。お客様側・係員側の
   * どちらからでも切り替えられ、**後から操作したほうが必ず勝つ**。
   */
  textVisible: boolean;
  /**
   * 係員が「お客様の声」を聞いているか（v1.42.0）。**既定はOFF**。
   *
   * ONの間だけ、お客様の音声を担当係員の画面へ中継する。常時流さないのは、
   * 事務室に絶えず声が流れることになるためと、聞かない通話の通信量を使わないため。
   */
  listenUserAudio?: boolean;
  /** 券面カメラの映像が最後に届いた時刻。映像の途絶検知（C-1）に使う。 */
  lastFaceFrameAt?: number;
  /** 今回の途絶をすでに障害履歴へ記録したか（1回の途絶で1件だけ記録する）。 */
  faceStallRecorded?: boolean;
}

/** 「お客様発話中」が確定テキストなしで残り続けないようにする上限。 */
const USER_SPEAKING_MAX_MS = 8_000;
/**
 * 音量だけで点いた（認識の実働＝途中経過がまだ無い）場合の上限。
 *
 * ★2026-08-14 の基本性能テストで、誰も話していないのに点く誤点灯が観察された。
 * 物音でも音量は超えるため、認識が動き出さないまま8秒残るのは長すぎる。
 * 途中経過が届いた時点で「本物の発話」とみなし、上の8秒に切り替える。
 */
const USER_SPEAKING_UNCONFIRMED_MS = 3_000;

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
    appVersion: APP_VERSION, // どの版での通話かを記録に残す（提案①）
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
    recordAppError({ type: "logsave", sessionId: session.sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), detail: "GCSへ保存できず（再試行も失敗）。サーバー内へ退避を試みた" });
    return;
  }

  try {
    await writeLocalLog(date, session.sessionId, log);
    console.log(`[log] saved: logs/${date}/${session.sessionId}.json (${session.transcript.length} entries)`);
  } catch (e) {
    console.error("[log] failed to save session log:", e);
    io.to(session.staffSocketId).emit("error:logSave", { sessionId: session.sessionId });
    recordAppError({ type: "logsave", sessionId: session.sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), detail: `通話ログを保存できなかった: ${String(e).slice(0, 120)}` });
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

// ── 障害履歴に添える情報 ──────────────────────────────────────────────────────
/** その通話を担当している係員の名前（離席・切断後は undefined）。 */
function staffNameOfSession(session: { staffSocketId: string }): string | undefined {
  return staffMap.get(session.staffSocketId)?.name;
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
  if (!speaking) session.speakingConfirmed = false; // 次の点灯はまた「音量だけ」から始まる
  if (session.userSpeaking === speaking) return;
  session.userSpeaking = speaking;
  io.to(session.staffSocketId).emit("user:speaking", { sessionId, speaking });
}

/** 「お客様発話中」の保険タイマーを張り直す（裏付けの有無で長さを変える）。 */
function armSpeakingTimer(sessionId: string, session: ActiveSession): void {
  if (session.speakingTimer) clearTimeout(session.speakingTimer);
  session.speakingTimer = setTimeout(() => {
    session.speakingTimer = undefined;
    setUserSpeaking(sessionId, session, false);
  }, session.speakingConfirmed ? USER_SPEAKING_MAX_MS : USER_SPEAKING_UNCONFIRMED_MS);
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
      armSpeakingTimer(sessionId, session);
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

/**
 * お客様側の音声認識の途中経過を受けたとき（sttStream から）。
 *
 * ★2026-08-14 の基本性能テスト対策。係員には確定テキストしか届かず、お客様が
 * 話し終えて確定が出るまでの約2秒間「話したことすら分からない」ため、係員が
 * かぶせて話してしまう事故が多発した。途中経過を係員画面にそのまま流す
 * （係員画面の表示側は当初から対応済みで、送る側が無かった）。
 *
 * 翻訳はしない：途中経過は数秒ごとに書き換わるうえ、目的は「今まさに話している」
 * ことを係員に見せることにある。訳文は確定時に付く。
 */
function noteUserInterim(socketId: string, transcript: string): void {
  for (const [sessionId, session] of activeSessions) {
    if (session.userSocketId !== socketId) continue;
    // 空文字＝消去の合図（確定が見張りに破棄された・マイクOFF）。表示済みの途中経過を
    // 消し、発話中表示も下ろす。これが無いと、破棄された発話の書きかけが係員画面に残る。
    if (!transcript) {
      io.to(session.staffSocketId).emit("speech:user", {
        sessionId, text: "", lang: session.userLang, isFinal: false,
      });
      setUserSpeaking(sessionId, session, false);
      return;
    }
    if (session.avatarSpeaking) return; // アバターの声を拾った分は流さない（発話中表示と同じ扱い）
    io.to(session.staffSocketId).emit("speech:user", {
      sessionId, text: transcript, lang: session.userLang, isFinal: false,
    });
    // 認識が実際に動いている＝物音ではなく発話。表示の保険を「確定待ち」の長さに延ばす
    session.speakingConfirmed = true;
    setUserSpeaking(sessionId, session, true);
    armSpeakingTimer(sessionId, session);
    return;
  }
}

/**
 * お客様の音声を担当係員の画面へ中継する（v1.42.0「お客様の声を聞く」）。
 *
 * これまでお客様の音声は、文字にしたら捨てていた。文字起こしには
 * ①モデルが文の途中で打ち切る取り逃し ②確定までの数秒の遅れ ③同音の書き間違い
 * という弱点があり、いずれも「耳で聞いていれば分かる」ものだった。認識の流れは
 * そのままに、同じ音のコピーを係員にも届けて補いにする。
 *
 * 送るのは「その通話の係員が聞くと決めているとき」だけ。アバターが読み上げて
 * いる間は送らない（キオスクは自分の声を拾わないよう無音を送っており、中継しても
 * 無音しか流れない）。
 */
function relayUserAudio(socketId: string, chunk: Buffer): void {
  for (const [sessionId, session] of activeSessions) {
    if (session.userSocketId !== socketId) continue;
    if (!session.listenUserAudio) return;
    if (session.avatarSpeaking) return;
    io.to(session.staffSocketId).emit("user:audio", { sessionId, chunk });
    return;
  }
}

// ── Google APIs ───────────────────────────────────────────────────────────────

/**
 * HTML方式で訳したとき、翻訳結果から保護用の印を取り除いて素の文に戻す。
 *
 * - `<span translate="no">…</span>` を外す（中身の目印はそのまま残す）
 * - HTMLの実体参照を文字に戻す（HTML方式では `'` が `&#39;` で返るため。
 *   `&amp;` は最後に戻す：先に戻すと `&amp;lt;` のような二重表記を壊す）
 * - 目印の直後に入る余分な空白を詰める（実測: 「… does not stop at [[4]] .」のように
 *   句点の前に空白が入る。`.` `,` `。` `、` の前は8言語のいずれでも空白を置かない）
 */
function stripProtectionMarkup(s: string): string {
  let out = s.replace(/<\/?span\b[^>]*>/gi, "");
  out = out
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  return out.replace(/[  ]+([.,。、])/g, "$1");
}

async function translateText(
  text: string, from: string, to: string, format: "text" | "html" = "text",
): Promise<string> {
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
    body: JSON.stringify({ q: text, source: from, target: to, format }),
  });
  const json = await res.json() as { data?: { translations?: Array<{ translatedText: string }> }; error?: { message: string } };
  if (json.error) {
    console.error(`[translate] API error [${from}→${to}]: ${json.error.message}`);
    throw new Error(`Translation API error: ${json.error.message}`);
  }
  const raw = json.data?.translations?.[0]?.translatedText ?? text;
  const translated = format === "html" ? stripProtectionMarkup(raw) : raw;
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
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const latinOnly = /^[A-Za-z0-9 .'-]+$/.test(src);
  if (!latinOnly) return new RegExp(esc(src), "gi");
  /**
   * ★語の区切り（空白・ハイフン）は表記が揺れるので、どの書き方でも一致させる。
   *
   * 2026-08-14 の基本性能テストで、英語の音声認識は駅名を **"bakuro-yokoyama"**
   * "mamiana cho" と区切って書き出していたのに、登録が "BAKUROYOKOYAMA"
   * "MAMIANACHOU" と続けた形だったため、英語→日本語の訳語固定が一度も効かず
   * 「バクロ横山」「マミアナチョー」というカタカナ訳になっていた。
   * 区切りを緩く見れば、登録をどちらの書き方にしても取りこぼさない。
   */
  const flexible = src.split(/[\s-]+/).filter(Boolean).map(esc).join("[\\s-]*");
  return new RegExp(`(?<![A-Za-z0-9])${flexible}(?![A-Za-z0-9])`, "gi");
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

  /**
   * ★2026-08-14 に方式を変更。目印をむき出しの `[[4]]` で渡すテキスト方式では、
   * 翻訳サービスに「ここは訳すな」と伝える手段が無く、目印そのものが書き換えられていた
   * （本番の実文で再現: 「急行は[[4]]に停まりません」→ "…does not stop at station 4."
   * が **8回中8回**。英・中簡体・中繁体・仏・西・タイの6言語で発生し、韓国語のみ無事）。
   *
   * HTML方式なら `translate="no"` が正式な「訳すな」の指示として効く（同じ文で8回中0回）。
   * 手順＝①素の文を用語→目印に置換 ②文全体をHTMLエスケープ ③目印を span で包む。
   * この順にすると、元の文に `<` や `&` が含まれていても壊れない（目印はASCIIなので
   * エスケープの影響を受けない）。訳文からは span と実体参照を戻して素の文にする。
   */
  const useHtml = replacements.length > 0;
  if (useHtml) {
    processed = processed
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    for (const { placeholder } of replacements) {
      processed = processed.split(placeholder).join(`<span translate="no">${placeholder}</span>`);
    }
  }

  let result = await translateText(processed, fromCode, toCode, useHtml ? "html" : "text");

  /**
   * 目印の生き残りを確かめる。
   *
   * ★2026-08-14 の基本性能テストで実害が出た。`[[4]]`（一覧の4番目＝馬喰横山）が
   * 翻訳の途中で **"station 4"** に書き換えられ、戻し処理が目印を見つけられずに素通り。
   * お客様には「急行は station 4 に停まりません」と流れた。戻せなかったことに
   * 気づく仕組みが無く、記録にも残らなかったのが問題の本体。
   *
   * 原因そのものは上の HTML方式（translate="no"）で塞いだが、この検査は**安全網として
   * 残す**。翻訳サービスの挙動は将来変わりうるし、壊れたときに黙って別の語が流れる
   * （＝誰も気づけない）のが今回いちばんの問題だったため。
   *
   * 壊れていたら、**用語集なしで訳し直す**。訳語の固定はあきらめることになるが、
   * 「station 4」のような無関係な語が混じるよりはるかにましで、Google 自身の訳
   * （Bakuroyokoyama 等）に落ち着く。あわせて障害履歴に残し、再発を見えるようにする。
   */
  const broken = replacements.filter(({ placeholder }) => !result.includes(placeholder));
  if (broken.length > 0) {
    console.error(
      `[translate] 用語集の目印が翻訳で壊れた（${broken.length}/${replacements.length}件・${fromLang}→${toLang}）` +
        ` 壊れた目印=${broken.map((b) => b.placeholder).join(",")} 訳文=${JSON.stringify(result.slice(0, 120))}`
    );
    recordAppError({
      type: "translate-glossary",
      detail:
        `用語集の訳語を固定できなかった（目印が翻訳で壊れた・${fromLang}→${toLang}）: ` +
        `対象語「${broken.map((b) => b.target).join("、").slice(0, 40)}」。用語集なしで訳し直した`,
    });
    return await translateText(text, fromCode, toCode);
  }

  replacements.forEach(({ placeholder, target }) => {
    result = result.split(placeholder).join(target);
  });
  return result;
}

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

/** `synthesizeAndStream` の結果。partial＝一部だけ届いた（＝途中が抜けた音声）。 */
interface TtsStreamResult {
  /** すべての断片を作れたか。 */
  ok: boolean;
  /** 実際に送れた断片の数。 */
  sent: number;
  /** 作ろうとした断片の数。 */
  total: number;
}

/**
 * 文の切れ目ごとに音声を作り、**できた順（＝文の順）に呼び出し元へ渡す**（C-2）。
 *
 * 従来は全文を作り終えてから一度に送っていたので、長い案内ほどお客様を待たせた。
 * ここでは全部を同時に作り始めたうえで、1文目から順に渡す。呼び出し元は1文目を
 * 受け取った時点で送り出せるので、**話し始めが「1文目の合成時間」まで縮む**。
 *
 * 実測（日本語・3回平均）: 53字の返答で 2.14秒 → 0.63秒、101字で 3.53秒 → 0.81秒。
 */
async function synthesizeAndStream(
  text: string,
  langCode: LangCode,
  onPiece: (audioBase64: string, index: number) => void,
): Promise<TtsStreamResult> {
  const lang = getLang(langCode);
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[tts] SKIP (no API key): "${text}" [${langCode}]`);
    return { ok: false, sent: 0, total: 0 };
  }
  const voiceLangCode = lang.ttsVoice.split("-").slice(0, 2).join("-");
  const pieces = splitForSpeech(text, langCode);
  if (!pieces.length) return { ok: false, sent: 0, total: 0 };

  // 全部同時に作り始める（待ち時間を積み上げない）。受け取りだけを順番に行う。
  const jobs = pieces.map((p) => synthesizeChunk(p, voiceLangCode, lang.ttsVoice, apiKey, langCode));
  let sent = 0;
  for (const job of jobs) {
    const buf = await job;
    if (!buf) continue; // 作れなかった断片は飛ばす（呼び出し元が ok=false で気づく）
    onPiece(buf.toString("base64"), sent);
    sent++;
  }
  console.log(`[tts] streamed "${text.slice(0, 30)}${text.length > 30 ? "…" : ""}" [${langCode}] ${sent}/${pieces.length} piece(s)`);
  return { ok: sent === pieces.length, sent, total: pieces.length };
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

  // 障害履歴が socket から「どの通話・どの端末・どちら側・どの係員か」を引けるようにする。
  // 音声認識の記録（認識ガード等）は sttStream 側で作られ、そこには通話の情報が無いため。
  setSocketContextResolver((socketId) => {
    for (const [sessionId, s] of activeSessions) {
      if (s.userSocketId === socketId) {
        return { sessionId, machineName: s.machineName, staffName: staffNameOfSession(s), side: "user" };
      }
      if (s.staffSocketId === socketId) {
        return { sessionId, machineName: s.machineName, staffName: staffNameOfSession(s), side: "staff" };
      }
    }
    // 通話に入っていない係員（待機中の動作確認など）
    const staff = staffMap.get(socketId);
    if (staff) return { staffName: staff.name, side: "staff" };
    return {};
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

  // ── 券面カメラの映像途絶の見張り（C-1）──────────────────────────────────
  // 一度でも映像が届いた通話で、10秒以上フレームが来なくなったら障害履歴に残す。
  // 通話自体は続いているのにカメラだけ止まった事象（実測: 2026-08-16 S10 で発生）を、
  // 後から「いつ・どの通話で」と追えるようにする。1回の途絶で記録は1件だけ
  // （復旧したら印を戻し、次の途絶をまた記録できるようにする）。
  const FACE_STALL_MS = 10_000;
  setInterval(() => {
    const now = Date.now();
    activeSessions.forEach((session, sessionId) => {
      if (!session.lastFaceFrameAt || session.faceStallRecorded) return;
      if (now - session.lastFaceFrameAt < FACE_STALL_MS) return;
      session.faceStallRecorded = true;
      recordAppError({
        type: "camera",
        sessionId,
        machineName: session.machineName,
        staffName: staffNameOfSession(session),
        side: "user",
        detail: `券面カメラの映像が${Math.round(FACE_STALL_MS / 1000)}秒以上途絶えた（通話は継続中）`,
      });
      console.log(`[camera] 映像途絶を記録: ${session.machineName} (${sessionId})`);
    });
  }, 5_000);

  io.on("connection", (socket: Socket) => {

    // ── Streaming STT (real-time, glossary-aware, long-form) ──────────────────
    // 音量から「お客様が話している」ことを検知したら係員画面に知らせる。マイクのON/OFF
    // ではなく実際の声で判定するので、将来キオスクのマイクを常時ONにしても そのまま動く。
    registerSttHandlers(
      socket,
      () => noteVoiceActivity(socket.id),
      // お客様側の途中経過を係員画面へ（係員側のソケットでは該当セッションが無く何もしない）
      (transcript) => noteUserInterim(socket.id, transcript),
      // お客様の生の声を担当係員へ（「お客様の声」がONの通話だけ）
      (chunk) => relayUserAudio(socket.id, chunk),
    );

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

      /**
       * ★同じ端末の「残骸」を先に片付ける（2026-08-14 基本性能テスト 日本語S6）。
       *
       * 通信の瞬断でお客様のクライアントが繋ぎ直すと、新しい接続で呼び出し直してくる。
       * このとき前の通話は、切断の検知（数秒〜十数秒）が終わるまでサーバーに残っており、
       * 従来はそのまま新しい通話を作っていた。結果、**同じお客様の通話が2つ並び**、
       * 係員画面が「同じお客様で2画面」になって混乱した（実測: 前の通話の終了4秒前に
       * 次の呼び出しが来ていた）。キオスクは1画面1通話なので、同じ端末からの新しい
       * 呼び出しは「前の通話のお客様側はもう存在しない」ことの確かな証拠。先に終わらせる。
       */
      activeSessions.forEach((old, oldId) => {
        if (old.machineId !== payload.machineId) return;
        activeSessions.delete(oldId);
        clearSpeakingState(old);
        releaseSession(oldId, old.staffSocketId);
        metrics.noteDisconnect(oldId); // 実態は切断由来の終了なので、切断として数える
        recordAppError({
          type: "disconnect", sessionId: oldId, machineName: old.machineName,
          staffName: staffNameOfSession(old), side: "user",
          detail: "同じ端末から新しい呼び出しが来たため、残っていた前の通話を終了した（通信の瞬断でお客様側が繋ぎ直したときの後片付け）",
        });
        io.to(old.staffSocketId).emit("call:userDisconnected", { sessionId: oldId, machineName: old.machineName });
        io.to(`session:${oldId}`).emit("call:ended", { sessionId: oldId });
        io.to("call-queue").emit("call:ended", { sessionId: oldId });
        saveSessionLog(old).catch((e) => console.error("[log] 幽霊通話の保存に失敗:", e));
        console.log(`[call] 同じ端末からの再呼び出しにより前の通話を終了: ${old.machineName} (${oldId})`);
      });
      // 応答前の古い呼び出しも同様（鳴りっぱなしの着信カードを取り下げる）。
      //
      // ★取り下げの合図は call:ended で送る（2026-08-16 日本語テストで発覚）。
      // call:taken は「他の係員が応答した」の意味で、係員画面はカードを消さずに
      // 灰色の「対応中」へ変えて残す（その通話の call:ended まで消えない設計）。
      // 取り下げた呼び出しには call:ended が二度と来ないため、灰色のカードが
      // 画面の再読み込みまで残り続けていた。以降の取り下げ系3経路＋拒否も同じ。
      callQueue.forEach((rec, oldId) => {
        if (rec.machineId !== payload.machineId) return;
        callQueue.delete(oldId);
        clearCallTimeout(oldId);
        io.to("call-queue").emit("call:ended", { sessionId: oldId });
        console.log(`[call] 同じ端末からの再呼び出しにより古い呼び出しを取り下げ: ${rec.machineName} (${oldId})`);
      });

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
      // ここでは計測を止めない。**送り出した瞬間まで**では通信も描画も含まれず、
      // 必ず0.00秒になってしまうため（実測で確認）。実際に係員の画面へ着信カードが
      // 出た時点で送られてくる call:incomingShown で止める。

      // 未応答タイムアウト: 応答・拒否・キャンセル・切断のいずれかで解除される。
      // 発火したら呼び出しを打ち切り、お客様へ「混み合っています」、係員へ通知を出す。
      callTimeouts.set(sessionId, setTimeout(() => {
        callTimeouts.delete(sessionId);
        const pending = callQueue.get(sessionId);
        if (!pending) return; // すでに応答済み等（保険。通常は解除済みでここに来ない）
        callQueue.delete(sessionId);
        io.to(pending.userSocketId).emit("call:timeout", { sessionId });
        // 着信カードを消す（call:taken だと灰色の「対応中」で残ってしまう）
        io.to("call-queue").emit("call:ended", { sessionId });
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
      // 拒否は「取り下げ」なので全係員のカードを消す（call:taken だと他の係員の
      // 画面に灰色の「対応中」が残り続ける）
      io.to("call-queue").emit("call:ended", { sessionId });
    });

    // ── Call ends ─────────────────────────────────────────────────────────────
    socket.on("call:end", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const session = activeSessions.get(sessionId);
      // Only a participant of this session may end it — the owning staff (終了ボタン) or
      // the kiosk user (キャンセルボタン). Blocks a race-losing *other* staff from tearing
      // down someone else's live call, without blocking the legitimate participants.
      if (session && session.staffSocketId !== socket.id && session.userSocketId !== socket.id) return;
      /**
       * ★2026-08-14 基本性能テスト（日本語S7）で見つけた二重保存の防止。
       * 従来は「保存(await・数秒)→一覧から削除」の順だったため、保存を待っている間に
       * **もう一方の参加者の call:end**（お客様と係員がほぼ同時に終了ボタン）や切断処理が
       * 入り込むと、通話がまだ一覧にあるため保存が二重に走った。測定値は takeMetrics() が
       * 取り出すと消える作りなので、**2回目の保存が空の測定値で記録を上書き**していた
       * （S7: 会話10件は無事なのに STT/TTS計測が0回）。先に一覧から外して
       * 「この終了処理が唯一」であることを確定させてから、通知→保存の順に行う。
       */
      if (session) {
        activeSessions.delete(sessionId);
        clearSpeakingState(session);
        releaseSession(sessionId, session.staffSocketId);
      }
      callQueue.delete(sessionId);
      clearCallTimeout(sessionId);
      /**
       * ★終了ボタン直前の発話の拾い上げ（2026-08-16 基本性能テスト 日本語S4）。
       *
       * 「ありがとうございました」と言った直後に終了を押すと、確定（話し終わりの約
       * 1.5秒後）より先に通話が畳まれ、最後の言葉が係員にも通話記録にも残らなかった。
       * お客様側の音声認識を半クローズし、言い終わっている分の確定を待つ（声が無ければ
       * 即座に空が返る。上限3秒）。通話の一覧からは既に外した後なので（上の二重保存
       * 防止）、待っている間にもう一方の参加者が終了を押しても二重処理にはならない。
       *
       * 拾えた確定は通常の発言と同じ形で係員へ表示し（call:ended はこの後に送るので
       * パネルはまだ開いている）、通話記録にも追記する。キオスク側の画面にも通常どおり
       * stt:final が届いて表示される。なお係員側の言い残しは対象外: 終了後に確定しても
       * お客様に読み上げられることはなく、「お客様が聞いていない発言」が記録に残ると
       * かえって紛らわしいため。
       */
      if (session) {
        const userSocket = io.sockets.sockets.get(session.userSocketId);
        const flush = userSocket?.data?.sttFlush as (() => Promise<string[]>) | undefined;
        const flushed = flush ? await flush().catch(() => [] as string[]) : [];
        for (const text of flushed) {
          let translatedText: string | undefined;
          if (session.userLang !== "ja") {
            try {
              translatedText = await translateWithGlossary(text, session.userLang, "ja");
            } catch { /* 訳せなくても原文は記録に残す */ }
          }
          session.transcript.push({
            id: `u-${Date.now()}-${entryCounter++}`,
            speaker: "user",
            text,
            translatedText,
            isFinal: true,
            timestamp: Date.now(),
          });
          io.to(session.staffSocketId).emit("speech:user", { sessionId, text, lang: session.userLang, isFinal: true, translatedText });
          console.log(`[call] 終了直前の発話を確定させて記録: ${JSON.stringify(text.slice(0, 40))} (${sessionId})`);
        }
      }
      io.to(`session:${sessionId}`).emit("call:ended", { sessionId });
      io.to("call-queue").emit("call:ended", { sessionId }); // Notify all staff to clear the call
      socket.leave(`session:${sessionId}`);
      broadcastStaffList();
      // 保存は最後（通知を待たせない）。この時点で一覧からは外れているので二重保存は起きない
      if (session) await saveSessionLog(session);
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
            recordAppError({ type: "translate", sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), side: "user", detail: `お客様の発言を翻訳できなかった（${lang}→日本語）: ${String(e).slice(0, 120)}` });
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

    // ── お客様マイクの状態（稼働中/一時停止/OFF）を係員画面へ中継 ──────────────
    socket.on("user:micState", (payload: { sessionId: string; state: "on" | "paused" | "off" }) => {
      const { sessionId, state } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      if (session.userSocketId !== socket.id) return; // 本人のキオスクのみ
      io.to(session.staffSocketId).emit("user:micState", { sessionId, state });
    });

    // ── 係員によるお客様マイクの入/切（担当係員のみ）───────────────────────────
    socket.on("staff:setUserMic", (payload: { sessionId: string; on: boolean }) => {
      const { sessionId, on } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      // 担当外の係員や古い画面からの操作を通さない（speech:staff と同じ守り）
      if (session.staffSocketId !== socket.id) return;
      io.to(session.userSocketId).emit("user:micControl", { on: !!on });
    });

    // ── 係員が「お客様の声」を聞く／やめる（担当係員のみ）──────────────────────
    // 既定はOFF。ONの間だけ relayUserAudio がお客様の音声をこの係員へ配る。
    // 最終的な状態はサーバーが持ち、確認の返事を送って係員画面の表示を合わせる
    // （押した直後にONに見えて実際は届いていない、という食い違いを作らないため）。
    socket.on("staff:listenUser", (payload: { sessionId: string; on: boolean }) => {
      const { sessionId, on } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      if (session.staffSocketId !== socket.id) return;
      session.listenUserAudio = !!on;
      io.to(session.staffSocketId).emit("user:audioState", { sessionId, on: !!on });
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

        if (isFinal) {
          metrics.noteStaffSpeechFinal(sessionId);
          // 係員はマイクを切っていても、ここから翻訳・音声合成が続く。返答が実際に出るまで
          // お客様側の「回答を準備しています」を出し続ける（お客様の画面が無反応になるのを防ぐ）。
          // synthesizing=true は「これから読み上げが届く」ことの合図。**係員がすぐ通話を
          // 終了しても、読み上げ終わりまでキオスクが画面を切り替えないため**に使う
          // （合成に1〜2秒かかるので、この合図が無いと call:ended のほうが先に着く）。
          io.to(session.userSocketId).emit("staff:composing", { sessionId, active: true, synthesizing: true });
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
        let speakText: string;
        if (userLang !== "ja") {
          try {
            translatedText = await translateWithGlossary(spoken, "ja", userLang);
          } catch (e) {
            console.error("[speech:staff] translation error:", e);
            translationFailed = true;
            recordAppError({ type: "translate", sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), side: "staff", detail: `係員の発言を翻訳できなかった（日本語→${userLang}）: ${String(e).slice(0, 120)}` });
            io.to(session.staffSocketId).emit("error:translation", { sessionId, direction: "jaToUser" });
            translatedText = text; // fallback: send Japanese text as-is
          }
          speakText = translatedText!;
        } else {
          translatedText = text;
          // 表示は text（登録どおりの SUICA）のまま、音声には読み（すいか）を渡す
          speakText = await toSpeakableJa(spoken);
        }

        /**
         * お客様への文字は「音声より先に、1回だけ」送る（C-2）。
         *
         * ★順番が重要: キオスクはこの確定を受けてマイクを一時停止する。音声が先に
         * 着くと、アバターの声を自分のマイクが拾ってしまう。1文目ができた時点で
         * 送るので、従来（全文の合成を待ってから送る）より早く届く。
         */
        let userTextSent = false;
        const sendUserText = (forceShowText: boolean) => {
          if (userTextSent) return;
          userTextSent = true;
          io.to(session.userSocketId).emit("speech:staff", {
            sessionId, text: translatedText, isFinal: true, forceShowText,
          });
        };

        const tts = await synthesizeAndStream(speakText, userLang, (audio, index) => {
          if (index === 0) {
            sendUserText(false);
            metrics.noteTtsSent(sessionId); // 測定は「1文目が出せた時刻」＝実際に声が始まる時刻
          }
          io.to(session.userSocketId).emit("tts:audio", { sessionId, audioBase64: audio, lang: userLang });
        });
        // 1つも作れなかった＝音声ゼロ。テキスト非表示の設定でもこの1件だけは文字を出す
        // （音声も文字も無い＝お客様に何も届かない状態を防ぐ）。
        sendUserText(true);
        // ★「この返答の音声はこれで全部」の合図。
        //   文ごとに送るようになったため、キオスクは1つ目を鳴らし終えた時点では
        //   まだ続きが来るのかどうか分からない。これが無いと、2つ目が間に合わなかった
        //   ときに読み上げ終了と誤判定し、**お客様のマイクが返答の途中で戻る**／
        //   **待たせていた通話終了が先に進んでしまう**。
        io.to(session.userSocketId).emit("tts:done", { sessionId });

        // 係員画面には日本語の原文に加えて訳文も返す。clientId は係員側が先に表示した
        // 吹き出しを特定するための目印（同じ文言を続けて話しても取り違えない）。
        io.to(session.staffSocketId).emit("speech:staff", {
          sessionId, text, isFinal: true, clientId,
          translatedText: userLang !== "ja" ? translatedText : undefined,
          // 4秒で消えるトーストを見逃しても分かるよう、発言そのものに印を残す。
          translationFailed, voiceFailed: !tts.ok,
        });

        // 係員は自分の発言が普通に表示されるため、音声が届かなかったことに気づけない。
        // 言い直せるように知らせる。partial=途中が抜けた音声が再生された場合。
        if (!tts.ok) {
          const partial = tts.sent > 0;
          // 途中が抜けた音声のときは、お客様の画面にも文字を出す。文字は音声より先に
          // 送ってしまっているので、あとから「この発言は文字も出して」と伝える。
          if (partial) io.to(session.userSocketId).emit("tts:incomplete", { sessionId });
          io.to(session.staffSocketId).emit("error:tts", { sessionId, partial, reason: "synthesis" });
          console.error(`[tts] 音声を届けられなかった session=${sessionId} partial=${partial} ${tts.sent}/${tts.total}`);
          recordAppError({ type: "tts-synthesis", sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), side: "staff", detail: `${partial ? "一部の" : ""}音声を合成できず文字のみ表示: ${text.slice(0, 60)}` });
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
        // 券面カメラの生存記録（途絶検知用）。復旧したら次の途絶も記録できるよう印を戻す
        if (camera !== "hand") {
          session.lastFaceFrameAt = Date.now();
          if (session.faceStallRecorded) {
            session.faceStallRecorded = false;
            console.log(`[camera] 券面カメラの映像が復旧: ${session.machineName} (${sessionId})`);
          }
        }
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

    // ── 端末側の異常の受け口（提案②・C-1）────────────────────────────────────
    // キオスク・係員画面で起きたことはサーバーからは見えない。導入後は端末を直接
    // 調べられないため、端末側から申告してもらい障害履歴へ残す。
    // 連投防止: 1ソケットにつき申告の種類ごとに1分に3件まで（画面側の暴走・悪意の
    // 連投で障害履歴が埋まり、本物の記録が押し出されるのを防ぐ）。種類ごとに分ける
    // のは、カメラ異常の連発が画面エラーの記録枠まで食い潰さないようにするため。
    const clientReportLimit = new Map<string, { windowStart: number; count: number }>();
    const allowClientReport = (kind: string): boolean => {
      const now = Date.now();
      const lim = clientReportLimit.get(kind) ?? { windowStart: now, count: 0 };
      if (now - lim.windowStart > 60_000) {
        lim.windowStart = now;
        lim.count = 0;
      }
      lim.count++;
      clientReportLimit.set(kind, lim);
      return lim.count <= 3;
    };

    // 画面のプログラムエラー（window.onerror / unhandledrejection）
    socket.on("client:error", (payload: { page?: string; machineName?: string; detail?: string }) => {
      if (!allowClientReport("client")) return;
      const detail = String(payload?.detail ?? "").slice(0, 300);
      if (!detail) return;
      const entry: Parameters<typeof recordSocketError>[1] = {
        type: "client-error",
        side: payload?.page === "staff" ? "staff" : "user",
        detail: `画面のプログラムエラー: ${detail}`,
      };
      // 端末名は申告値があれば添える（キオスクは匿名接続のため自己申告しかない）
      if (typeof payload?.machineName === "string" && payload.machineName.trim()) {
        entry.machineName = payload.machineName.slice(0, 40);
      }
      recordSocketError(socket.id, entry);
      console.log(`[client-error] ${entry.side} ${entry.machineName ?? ""}: ${detail.slice(0, 80)}`);
    });

    // カメラの取得失敗（C-1）。キオスクが getUserMedia の失敗を種類つきで申告する。
    const CAMERA_ERR_JA: Record<string, string> = {
      "denied": "カメラの使用が許可されていない",
      "in-use": "他のアプリがカメラを使用中で取得できない",
      "not-found": "カメラが見つからない（未接続・無効）",
      "gone": "使っていたカメラが外れた（接続し直しが必要）",
      "error": "カメラの取得に失敗した",
    };
    socket.on("camera:error", (payload: { sessionId?: string; machineName?: string; camera?: string; code?: string; detail?: string }) => {
      if (!allowClientReport("camera")) return;
      const code = CAMERA_ERR_JA[payload?.code ?? ""] ? payload!.code! : "error";
      const camera = payload?.camera === "hand" ? "手元カメラ" : payload?.camera === "detect" ? "カメラ検出" : "券面カメラ";
      const extra = String(payload?.detail ?? "").slice(0, 120);
      // 通話が特定できる場合はその通話の担当・端末を記録に添える
      const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
      const session = sessionId ? activeSessions.get(sessionId) : undefined;
      if (session && session.userSocketId !== socket.id) return; // 本人のキオスクのみ
      const entry: Parameters<typeof recordSocketError>[1] = {
        type: "camera",
        side: "user",
        detail: `${camera}: ${CAMERA_ERR_JA[code]}${extra ? `（${extra}）` : ""}`,
      };
      if (sessionId) entry.sessionId = sessionId;
      if (session) {
        entry.machineName = session.machineName;
        entry.staffName = staffNameOfSession(session);
        // 担当の係員画面へも知らせる（「映像なし」の枠に理由を出す）
        io.to(session.staffSocketId).emit("camera:error", { sessionId, code });
      } else if (typeof payload?.machineName === "string" && payload.machineName.trim()) {
        entry.machineName = payload.machineName.slice(0, 40);
      }
      recordSocketError(socket.id, entry);
      console.log(`[camera] 取得失敗 ${entry.machineName ?? ""}: ${entry.detail}`);
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
      recordAppError({ type: "tts-playback", sessionId: payload.sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), side: "user", detail: "お客様の端末で音声を再生できなかった（文字のみ表示）" });
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
      if (payload.code) recordAppError({ type: "mic-user", sessionId: payload.sessionId, machineName: session.machineName, staffName: staffNameOfSession(session), side: "user", detail: `お客様側のマイク異常: ${payload.code}` });
    });

    // ── 着信が係員の画面に出た（性能測定用）────────────────────────────────
    // 「呼び出し→係員画面に着信表示」を測るための合図。複数の係員に配信されるので
    // **最初に届いた1件だけ**を採用する（＝最も早く表示された係員までの時間）。
    // 2件目以降は noteCallIncoming の中で無視される。
    socket.on("call:incomingShown", (payload: { sessionId: string }) => {
      if (!getStaffSession(socket)) return;
      if (!payload?.sessionId) return;
      metrics.noteCallIncoming(payload.sessionId);
    });

    // ── 係員自身のマイク異常 ──────────────────────────────────────────────────
    // 係員の画面には警告が出るが、それだけでは後から「あの日あの係員のマイクが
    // 不調だった」を追えない。お客様側（user:micError）と同じく記録に残す。
    // 通話中でなくても起こる（待機中の動作確認など）ので、通話の有無は問わない。
    socket.on("staff:micError", (payload: { code: string | null }) => {
      if (!getStaffSession(socket)) return;
      const staff = staffMap.get(socket.id);
      const name = staff?.name ?? getStaffSession(socket)?.name ?? "名前不明";
      console.log(`[mic] 係員のマイク異常 staff=${name} code=${payload?.code ?? "解消"}`);
      if (!payload?.code) return; // null は解消の合図
      // 対応中の通話があれば、どの通話中だったかも残す（複数なら1件目）
      let sessionId: string | undefined;
      let machineName: string | undefined;
      for (const [sid, s] of activeSessions) {
        if (s.staffSocketId === socket.id) { sessionId = sid; machineName = s.machineName; break; }
      }
      recordAppError({
        type: "mic-staff",
        sessionId,
        machineName,
        staffName: name,
        side: "staff",
        detail: `係員側のマイク異常: ${payload.code}`,
      });
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
          const isUser = session.userSocketId === socket.id;
          recordAppError({
            type: "disconnect",
            sessionId,
            machineName: session.machineName,
            // 係員が切れた場合はその係員、お客様が切れた場合は対応中だった係員
            staffName: isUser ? staffNameOfSession(session) : staffName,
            side: isUser ? "user" : "staff",
            detail: `通話中に${isUser ? "お客様" : "係員"}の接続が切れた: ${disconnectReasonJa(reason)}`,
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
            side: "user",
            detail: `呼び出し中（応答前）にお客様の接続が切れた: ${disconnectReasonJa(reason)}`,
          });
          callQueue.delete(sessionId);
          clearCallTimeout(sessionId);
          // 取り下げなのでカードを消す（call:taken だと灰色の「対応中」で残る。
          // 2026-08-16 の幽霊カードの実例はこの経路: 応答前にお客様の接続が切れ、
          // 灰色カードが再読み込みまで残った）
          io.to("call-queue").emit("call:ended", { sessionId });
        }
      });

      broadcastStaffList();
    });
  });
}
