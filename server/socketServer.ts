import { Server, Socket } from "socket.io";
import type { IncomingMessage, ServerResponse } from "http";
import type { Server as HttpServer } from "http";
import { getCached, setCache } from "../lib/translateCache";
import { getLang, getGoogleTranslateLangCode } from "../lib/languages";
import type { LangCode } from "../lib/socketEvents";

// Read lazily inside functions so that .env.local is loaded by the time they're called
function getApiKey(): string {
  return process.env.GOOGLE_API_KEY || "";
}

const STAFF_NAME = "駅員";

interface CallRecord {
  sessionId: string;
  machineId: string;
  machineName: string;
  userSocketId: string;
  userLang: LangCode;
  timestamp: number;
}

interface ActiveSession extends CallRecord {
  staffSocketId: string;
}

const callQueue = new Map<string, CallRecord>();
const activeSessions = new Map<string, ActiveSession>();

let io: Server;

async function translateText(text: string, from: string, to: string): Promise<string> {
  if (from === to) return text;
  const cached = getCached(text, from, to);
  if (cached) return cached;

  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[translate] SKIP (no API key): "${text}" [${from}→${to}]`);
    return text;
  }

  try {
    const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, source: from, target: to, format: "text" }),
    });
    const json = await res.json() as { data?: { translations?: Array<{ translatedText: string }> }; error?: { message: string } };
    if (json.error) {
      console.error(`[translate] API error [${from}→${to}]: ${json.error.message}`);
      return text;
    }
    const translated = json.data?.translations?.[0]?.translatedText ?? text;
    console.log(`[translate] "${text}" → "${translated}" [${from}→${to}]`);
    setCache(text, from, to, translated);
    return translated;
  } catch (e) {
    console.error(`[translate] fetch error [${from}→${to}]:`, e);
    return text;
  }
}

async function synthesizeSpeech(text: string, langCode: LangCode): Promise<string> {
  const lang = getLang(langCode);
  const apiKey = getApiKey();

  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn(`[tts] SKIP (no API key): "${text}" [${langCode}] → will use browser Web Speech fallback`);
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

export function initSocketServer(httpServer: HttpServer<typeof IncomingMessage, typeof ServerResponse>): void {
  // Warn here (after app.prepare()) so .env.local has been loaded by Next.js
  const apiKey = getApiKey();
  if (!apiKey || apiKey === "your_google_api_key_here") {
    console.warn("⚠️  [socketServer] GOOGLE_API_KEY is not configured!");
    console.warn("    翻訳・TTSが動作しません。.env.local に GOOGLE_API_KEY を設定してサーバーを再起動してください。");
  } else {
    console.log(`✅ [socketServer] GOOGLE_API_KEY 設定済み (${apiKey.slice(0, 8)}...)`);
  }

  io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    path: "/socket.io",
  });

  io.on("connection", (socket: Socket) => {
    // --- Staff joins call queue room ---
    socket.on("staff:join", () => {
      socket.join("call-queue");
      // Send current pending calls to newly joined staff
      callQueue.forEach((call) => {
        socket.emit("call:incoming", {
          sessionId: call.sessionId,
          machineId: call.machineId,
          machineName: call.machineName,
          timestamp: call.timestamp,
        });
      });
    });

    // --- User requests a call ---
    socket.on("call:request", (payload: { machineId: string; machineName: string; userLang?: LangCode }) => {
      const sessionId = generateSessionId();
      const record: CallRecord = {
        sessionId,
        machineId: payload.machineId,
        machineName: payload.machineName,
        userSocketId: socket.id,
        userLang: payload.userLang ?? "ja",
        timestamp: Date.now(),
      };
      callQueue.set(sessionId, record);
      socket.join(`session:${sessionId}`);

      io.to("call-queue").emit("call:incoming", {
        sessionId,
        machineId: payload.machineId,
        machineName: payload.machineName,
        userLang: record.userLang,
        timestamp: record.timestamp,
      });
    });

    // --- Staff answers a call ---
    socket.on("call:answer", async (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);
      if (!record) return;

      callQueue.delete(sessionId);
      const session: ActiveSession = { ...record, staffSocketId: socket.id };
      activeSessions.set(sessionId, session);

      socket.join(`session:${sessionId}`);

      // Notify other staff this call was taken
      io.to("call-queue").emit("call:taken", { sessionId });

      // Notify the user
      io.to(record.userSocketId).emit("call:answered", {
        sessionId,
        staffName: STAFF_NAME,
      });
    });

    // --- Staff rejects a call (before answering) ---
    socket.on("call:reject", (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      const record = callQueue.get(sessionId);
      if (!record) return;
      callQueue.delete(sessionId);
      io.to(record.userSocketId).emit("call:rejected", { sessionId });
      io.to("call-queue").emit("call:taken", { sessionId }); // remove from other staff queues too
    });

    // --- Either side ends the call ---
    socket.on("call:end", (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      activeSessions.delete(sessionId);
      callQueue.delete(sessionId);
      io.to(`session:${sessionId}`).emit("call:ended", { sessionId });
      // Clean up room membership
      socket.leave(`session:${sessionId}`);
    });

    // --- User speaking ---
    socket.on(
      "speech:user",
      async (payload: { sessionId: string; text: string; lang: LangCode; isFinal: boolean }) => {
        const { sessionId, text, lang, isFinal } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;

        // Update session lang
        if (lang !== session.userLang) {
          session.userLang = lang;
        }

        let translatedText: string | undefined;
        if (isFinal && lang !== "ja") {
          const fromCode = getGoogleTranslateLangCode(lang);
          translatedText = await translateText(text, fromCode, "ja");
        }

        // Relay to staff socket
        io.to(session.staffSocketId).emit("speech:user", {
          sessionId,
          text,
          lang,
          isFinal,
          translatedText,
        });
      }
    );

    // --- Staff speaking ---
    socket.on(
      "speech:staff",
      async (payload: { sessionId: string; text: string; isFinal: boolean }) => {
        const { sessionId, text, isFinal } = payload;
        const session = activeSessions.get(sessionId);
        if (!session) return;

        const userLang = session.userLang;
        let translatedText: string | undefined;
        let audioBase64 = "";

        if (!isFinal) {
          // Interim: relay staff text only (no TTS, no translation)
          io.to(session.staffSocketId).emit("speech:staff", {
            sessionId,
            text,
            isFinal: false,
          });
          io.to(session.userSocketId).emit("speech:staff", {
            sessionId,
            text: userLang === "ja" ? text : "",
            isFinal: false,
          });
          return;
        }

        // Final: translate and synthesize
        if (userLang !== "ja") {
          const toCode = getGoogleTranslateLangCode(userLang);
          translatedText = await translateText(text, "ja", toCode);
          audioBase64 = await synthesizeSpeech(translatedText, userLang);
        } else {
          translatedText = text;
          audioBase64 = await synthesizeSpeech(text, "ja");
        }

        // To staff: original Japanese + translated version
        io.to(session.staffSocketId).emit("speech:staff", {
          sessionId,
          text,
          isFinal: true,
          translatedText: userLang !== "ja" ? translatedText : undefined,
        });

        // To user: translated text
        io.to(session.userSocketId).emit("speech:staff", {
          sessionId,
          text: translatedText,
          isFinal: true,
        });

        // TTS audio to user
        if (audioBase64) {
          io.to(session.userSocketId).emit("tts:audio", {
            sessionId,
            audioBase64,
            lang: userLang,
          });
        }
      }
    );

    // --- Screen share from staff to user ---
    socket.on("screen:share", (payload: { sessionId: string; frameData: string }) => {
      const { sessionId, frameData } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      // Use socket.to() to send to everyone in the session room EXCEPT the sender (staff)
      socket.to(`session:${sessionId}`).emit("screen:share", { sessionId, frameData });
    });

    // --- Camera frame from user to staff ---
    socket.on("screen:frame", (payload: { sessionId: string; frameData: string }) => {
      const { sessionId, frameData } = payload;
      const session = activeSessions.get(sessionId);
      if (!session) return;
      io.to(session.staffSocketId).emit("screen:frame", { sessionId, frameData });
    });

    // --- Language update from user ---
    socket.on("session:setLang", (payload: { sessionId: string; lang: LangCode }) => {
      const session = activeSessions.get(payload.sessionId);
      if (session) session.userLang = payload.lang;
    });

    // --- Disconnect cleanup ---
    socket.on("disconnect", () => {
      activeSessions.forEach((session, sessionId) => {
        if (session.staffSocketId === socket.id || session.userSocketId === socket.id) {
          activeSessions.delete(sessionId);
          io.to(`session:${sessionId}`).emit("call:ended", { sessionId });
        }
      });
      callQueue.forEach((record, sessionId) => {
        if (record.userSocketId === socket.id) {
          callQueue.delete(sessionId);
          io.to("call-queue").emit("call:taken", { sessionId });
        }
      });
    });
  });
}
