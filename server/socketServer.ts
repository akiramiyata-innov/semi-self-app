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
import { getGlossaryTerms } from "../lib/glossaryClient";
import { getAssignments } from "../lib/assignmentClient";
import type { GlossaryTerm } from "../lib/types";

function getApiKey(): string {
  return process.env.GOOGLE_API_KEY || "";
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
}

const callQueue = new Map<string, CallRecord>();
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
  };
  const date = new Date(endedAt).toISOString().slice(0, 10);

  if (isGCSEnabled()) {
    try {
      await uploadLog(date, session.sessionId, log);
      console.log(`[log] saved to GCS: logs/${date}/${session.sessionId}.json (${session.transcript.length} entries)`);
    } catch (e) {
      console.error("[log] failed to save to GCS:", e);
    }
    return;
  }

  const dir = path.join(process.cwd(), "logs", date);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, `${session.sessionId}.json`),
      JSON.stringify(log, null, 2)
    );
    console.log(`[log] saved: logs/${date}/${session.sessionId}.json (${session.transcript.length} entries)`);
  } catch (e) {
    console.error("[log] failed to save session log:", e);
  }
}

// ── Staff eligibility ─────────────────────────────────────────────────────────
// Staff who would see this station's incoming call card (not away, no station
// restriction or explicitly assigned to it). Reused for both call:incoming and
// the pre-answer face-camera preview so a staff member never receives video for
// a call they can't see/take.
function getEligibleStaffSocketIds(stationId: string): string[] {
  const ids: string[] = [];
  staffMap.forEach((staff) => {
    if (staff.status === "away") return;
    if (stationId && staff.assignedStations.length > 0 && !staff.assignedStations.includes(stationId)) return;
    ids.push(staff.socketId);
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

async function translateWithGlossary(text: string, fromLang: string, toLang: string): Promise<string> {
  const terms = await getGlossaryTerms();
  const replacements: Array<{ placeholder: string; target: string }> = [];
  let processed = text;

  terms.forEach((term: GlossaryTerm, i: number) => {
    const src = term[fromLang as keyof GlossaryTerm] as string | undefined;
    const tgt = term[toLang as keyof GlossaryTerm] as string | undefined;
    if (src && tgt && processed.includes(src)) {
      const placeholder = `GLOSS${i}TERM`;
      processed = processed.split(src).join(placeholder);
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

async function synthesizeSpeech(text: string, langCode: LangCode): Promise<string> {
  const lang = getLang(langCode);
  const apiKey = getApiKey();

  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[tts] SKIP (no API key): "${text}" [${langCode}]`);
    return "";
  }

  try {
    const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: lang.bcp47, name: lang.ttsVoice },
        audioConfig: { audioEncoding: "MP3" },
      }),
    });
    const json = await res.json() as { audioContent?: string; error?: { message: string } };
    if (json.error) {
      console.error(`[tts] API error [${langCode}]: ${json.error.message}`);
      return "";
    }
    console.log(`[tts] synthesized "${text}" [${langCode}] → ${json.audioContent ? `${json.audioContent.length} chars` : "EMPTY"}`);
    return json.audioContent ?? "";
  } catch (e) {
    console.error(`[tts] fetch error [${langCode}]:`, e);
    return "";
  }
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

  io.on("connection", (socket: Socket) => {

    // ── Staff joins ───────────────────────────────────────────────────────────
    socket.on("staff:join", async (payload?: { name?: string; uid?: string; stationIds?: string[] }) => {
      const name = (payload?.name ?? "").trim() || "スタッフ";
      const uid = payload?.uid ?? "";

      // stationIds が直接渡された場合はそれを優先（キャッシュ遅延を回避）
      const assignedStations = payload?.stationIds ?? (uid ? await getAssignments(uid).catch(() => []) : []);

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

      socket.join("call-queue");

      // Send current queue to this staff
      callQueue.forEach((call) => {
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
    });

    // ── Staff answers a call ──────────────────────────────────────────────────
    socket.on("call:answer", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);

      if (!record) {
        // Race condition: another staff already answered
        socket.emit("call:alreadyTaken", { sessionId });
        return;
      }

      callQueue.delete(sessionId);
      const session: ActiveSession = {
        ...record,
        staffSocketId: socket.id,
        startedAt: Date.now(),
        transcript: [],
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
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);
      if (!record) return;
      callQueue.delete(sessionId);
      io.to(record.userSocketId).emit("call:rejected", { sessionId });
      io.to("call-queue").emit("call:taken", { sessionId });
    });

    // ── Call ends ─────────────────────────────────────────────────────────────
    socket.on("call:end", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const session = activeSessions.get(sessionId);
      // Only the staff who owns an active session may end it — prevents a race-losing
      // staff's 終了 from tearing down the winning staff's live call.
      if (session && session.staffSocketId !== socket.id) return;
      if (session) {
        await saveSessionLog(session);
        releaseSession(sessionId, session.staffSocketId);
      }
      activeSessions.delete(sessionId);
      callQueue.delete(sessionId);
      io.to(`session:${sessionId}`).emit("call:ended", { sessionId });
      io.to("call-queue").emit("call:ended", { sessionId }); // Notify all staff to clear the call
      socket.leave(`session:${sessionId}`);
      broadcastStaffList();
    });

    // ── Speech: user → staff ──────────────────────────────────────────────────
    socket.on(
      "speech:user",
      async (payload: { sessionId: string; text: string; lang: LangCode; isFinal: boolean }) => {
        const { sessionId, text, lang, isFinal } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;

        if (lang !== session.userLang) session.userLang = lang;

        let translatedText: string | undefined;
        if (isFinal && lang !== "ja") {
          try {
            translatedText = await translateWithGlossary(text, lang, "ja");
          } catch (e) {
            console.error("[speech:user] translation error:", e);
            io.to(session.staffSocketId).emit("error:translation", { sessionId, direction: "userToJa" });
          }
        }

        if (isFinal) {
          session.transcript.push({
            id: `u-${Date.now()}-${entryCounter++}`,
            speaker: "user",
            text,
            translatedText,
            isFinal: true,
            timestamp: Date.now(),
          });
        }

        io.to(session.staffSocketId).emit("speech:user", { sessionId, text, lang, isFinal, translatedText });
      }
    );

    // ── Speech: staff → user ──────────────────────────────────────────────────
    socket.on(
      "speech:staff",
      async (payload: { sessionId: string; text: string; isFinal: boolean }) => {
        const { sessionId, text, isFinal } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;
        // Only the staff who owns this session may speak into it — guards against a
        // staff who lost an answer race (or a stale client) leaking audio into the call.
        if (session.staffSocketId !== socket.id) return;

        const userLang = session.userLang;
        let translatedText: string | undefined;
        let audioBase64 = "";

        if (!isFinal) {
          io.to(session.staffSocketId).emit("speech:staff", { sessionId, text, isFinal: false });
          io.to(session.userSocketId).emit("speech:staff", {
            sessionId,
            text: userLang === "ja" ? text : "",
            isFinal: false,
          });
          return;
        }

        if (userLang !== "ja") {
          try {
            translatedText = await translateWithGlossary(text, "ja", userLang);
          } catch (e) {
            console.error("[speech:staff] translation error:", e);
            io.to(session.staffSocketId).emit("error:translation", { sessionId, direction: "jaToUser" });
            translatedText = text; // fallback: send Japanese text as-is
          }
          audioBase64 = await synthesizeSpeech(translatedText!, userLang);
        } else {
          translatedText = text;
          audioBase64 = await synthesizeSpeech(text, "ja");
        }

        io.to(session.staffSocketId).emit("speech:staff", {
          sessionId, text, isFinal: true,
          translatedText: userLang !== "ja" ? translatedText : undefined,
        });

        io.to(session.userSocketId).emit("speech:staff", { sessionId, text: translatedText, isFinal: true });

        if (audioBase64) {
          io.to(session.userSocketId).emit("tts:audio", { sessionId, audioBase64, lang: userLang });
        }

        session.transcript.push({
          id: `s-${Date.now()}-${entryCounter++}`,
          speaker: "staff",
          text,
          translatedText: userLang !== "ja" ? translatedText : undefined,
          isFinal: true,
          timestamp: Date.now(),
        });
      }
    );

    // ── Screen share (staff → user) ───────────────────────────────────────────
    socket.on("screen:share", (payload: { sessionId: string; frameData: string }) => {
      const { sessionId, frameData } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      socket.to(`session:${sessionId}`).emit("screen:share", { sessionId, frameData });
    });

    // ── Camera frame (user → staff) ───────────────────────────────────────────
    socket.on("screen:frame", (payload: { sessionId: string; frameData: string; camera?: CameraId }) => {
      const { sessionId, frameData, camera } = payload;

      const session = activeSessions.get(sessionId);
      if (session) {
        io.to(session.staffSocketId).emit("screen:frame", { sessionId, frameData, camera });
        return;
      }

      // Call not yet answered — relay the face-camera preview to every staff
      // member who can see this call's incoming card (same eligibility as call:incoming).
      const pending = callQueue.get(sessionId);
      if (!pending) return;
      getEligibleStaffSocketIds(pending.stationId).forEach((sid) => {
        io.to(sid).emit("screen:frame", { sessionId, frameData, camera });
      });
    });

    // ── Language update ───────────────────────────────────────────────────────
    socket.on("session:setLang", (payload: { sessionId: string; lang: LangCode }) => {
      const session = activeSessions.get(payload.sessionId);
      if (session) session.userLang = payload.lang;
    });

    // ── Disconnect cleanup ────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      staffMap.delete(socket.id);

      activeSessions.forEach((session, sessionId) => {
        if (session.staffSocketId === socket.id || session.userSocketId === socket.id) {
          saveSessionLog(session).catch((e) => console.error("[log] disconnect save error:", e));

          // If user disconnected, free the staff member
          if (session.userSocketId === socket.id) {
            // User disconnected — notify staff
            io.to(session.staffSocketId).emit("call:userDisconnected", {
              sessionId,
              machineName: session.machineName,
            });
            releaseSession(sessionId, session.staffSocketId);
            activeSessions.delete(sessionId);
            io.to(session.staffSocketId).emit("call:ended", { sessionId });
            io.to("call-queue").emit("call:ended", { sessionId });
          } else {
            // Staff disconnected — notify user with a distinct event (not call:ended)
            io.to(session.userSocketId).emit("call:staffDisconnected", { sessionId });
            releaseSession(sessionId, session.staffSocketId);
            activeSessions.delete(sessionId);
            io.to("call-queue").emit("call:ended", { sessionId });
          }
        }
      });

      callQueue.forEach((record, sessionId) => {
        if (record.userSocketId === socket.id) {
          callQueue.delete(sessionId);
          io.to("call-queue").emit("call:taken", { sessionId });
        }
      });

      broadcastStaffList();
    });
  });
}
