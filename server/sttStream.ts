import type { Socket } from "socket.io";
import type { SpeechClient } from "@google-cloud/speech";
import { getSpeechClient } from "../lib/speechClient";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import type { GlossaryTerm } from "../lib/types";

// Google streaming recognition has a ~5-minute per-stream limit. Reopen the stream
// before then so long (2 min+) speech continues seamlessly — this is what lets us
// beat the ~30s practical cap of the sync API on browser (MediaRecorder) audio.
const STREAM_RESTART_MS = 4.5 * 60 * 1000;
const BOOST = 15;

type SpeechStream = ReturnType<SpeechClient["streamingRecognize"]>;

/** Minimal shape of a StreamingRecognizeResponse we consume. */
interface StreamingResult {
  results?: Array<{
    isFinal?: boolean | null;
    alternatives?: Array<{ transcript?: string | null }> | null;
  }> | null;
}

/**
 * Registers per-socket streaming STT: the client sends `stt:start` then a series
 * of raw 16kHz mono PCM chunks via `stt:audio`, and receives `stt:interim` /
 * `stt:final` transcripts in real time. `stt:stop` (or disconnect) ends it.
 */
export function registerSttHandlers(socket: Socket): void {
  let stream: SpeechStream | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let lang = "ja-JP";
  let phrases: string[] = [];
  let running = false;

  function openStream(): void {
    const client = getSpeechClient();
    if (!client) {
      socket.emit("stt:error", { message: "STT unavailable (no API key)" });
      return;
    }
    const s = client.streamingRecognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: lang || "ja-JP",
        enableAutomaticPunctuation: true,
        ...(phrases.length > 0 ? { speechContexts: [{ phrases, boost: BOOST }] } : {}),
      },
      interimResults: true,
    });
    s.on("data", (data: StreamingResult) => {
      const r = data.results?.[0];
      if (!r) return;
      const transcript = r.alternatives?.[0]?.transcript ?? "";
      if (r.isFinal) socket.emit("stt:final", { transcript });
      else socket.emit("stt:interim", { transcript });
    });
    s.on("error", (err: Error) => {
      console.error("[stt] stream error:", err.message);
      socket.emit("stt:error", { message: err.message });
      if (stream === s) stream = null; // a fresh stt:start (or restart) reopens
    });
    stream = s;
  }

  function scheduleRestart(): void {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!running) return;
      const old = stream; // open the new stream first, then end the old → no gap
      openStream();
      try { old?.end(); } catch { /* already ended */ }
      scheduleRestart();
    }, STREAM_RESTART_MS);
  }

  function stopStream(): void {
    running = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const s = stream;
    stream = null;
    try { s?.end(); } catch { /* already ended */ }
  }

  socket.on("stt:start", async (payload?: { lang?: string }) => {
    lang = payload?.lang || "ja-JP";
    const terms = await getGlossaryTermsFresh().catch(() => [] as GlossaryTerm[]);
    phrases = terms.map((t) => t.ja).filter(Boolean);
    running = true;
    openStream();
    scheduleRestart();
  });

  socket.on("stt:audio", (chunk: ArrayBuffer | Buffer) => {
    if (!stream) return;
    try {
      stream.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch { /* stream closing */ }
  });

  socket.on("stt:stop", stopStream);
  socket.on("disconnect", stopStream);
}
