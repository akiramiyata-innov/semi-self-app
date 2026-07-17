import type { Socket } from "socket.io";
import type { v2 } from "@google-cloud/speech";
import { getSpeechClient, RECOGNIZER, SPEECH_MODEL } from "../lib/speechClient";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import type { GlossaryTerm } from "../lib/types";

// Google streaming recognition has a per-stream time limit. Reopen the stream
// before then so long (2 min+) speech continues seamlessly.
const STREAM_RESTART_MS = 4.5 * 60 * 1000;
// V2 model adaptation caps the phrase boost at 20 (higher → INVALID_ARGUMENT).
const BOOST = 20;

type SpeechStream = ReturnType<v2.SpeechClient["_streamingRecognize"]>;

/** Minimal shape of a V2 StreamingRecognizeResponse we consume. */
interface StreamingResult {
  results?: Array<{
    isFinal?: boolean | null;
    alternatives?: Array<{ transcript?: string | null }> | null;
  }> | null;
}

/**
 * Registers per-socket streaming STT (Speech-to-Text **V2**, chirp_2 model). The
 * client sends `stt:start` then raw 16kHz mono PCM chunks via `stt:audio`, and
 * receives `stt:interim` / `stt:final` transcripts in real time. `stt:stop` (or
 * disconnect) ends it. Registered glossary terms are passed as inline model
 * adaptation so domain words (station names, jargon) are recognized correctly —
 * this is what the classic V1 phrase hints failed to do.
 */
export function registerSttHandlers(socket: Socket): void {
  let stream: SpeechStream | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let lang = "ja-JP";
  let phrases: string[] = [];
  let running = false;

  async function openStream(): Promise<void> {
    const client = await getSpeechClient();
    if (!client) {
      socket.emit("stt:error", { message: "STT unavailable (no credentials)" });
      return;
    }
    // Adaptation phrases are the Japanese glossary terms, so only apply them to
    // Japanese recognition (they would not help — and could hurt — other langs).
    const useAdaptation = phrases.length > 0 && lang.startsWith("ja");
    const config = {
      explicitDecodingConfig: { encoding: "LINEAR16" as const, sampleRateHertz: 16000, audioChannelCount: 1 },
      languageCodes: [lang || "ja-JP"],
      model: SPEECH_MODEL,
      ...(useAdaptation
        ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: phrases.map((value) => ({ value, boost: BOOST })) } }] } }
        : {}),
    };
    // V2 streaming needs the recognizer in the routing header (x-goog-request-params);
    // without it the regional backend rejects the request ("Invalid resource field value").
    const s = client._streamingRecognize({
      otherArgs: { headers: { "x-goog-request-params": `recognizer=${encodeURIComponent(RECOGNIZER)}` } },
    });
    s.on("data", (data: StreamingResult) => {
      const r = data.results?.[0];
      if (!r) return;
      const transcript = r.alternatives?.[0]?.transcript ?? "";
      if (!transcript) return;
      if (r.isFinal) socket.emit("stt:final", { transcript });
      else socket.emit("stt:interim", { transcript });
    });
    s.on("error", (err: Error) => {
      console.error("[stt] stream error:", err.message);
      socket.emit("stt:error", { message: err.message });
      if (stream === s) stream = null; // a fresh stt:start (or restart) reopens
    });
    // First message: recognizer + streaming config. Subsequent writes are audio.
    s.write({ recognizer: RECOGNIZER, streamingConfig: { config, streamingFeatures: { interimResults: true } } });
    stream = s;
  }

  function scheduleRestart(): void {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      if (!running) return;
      const old = stream; // open the new stream first, then end the old → no gap
      await openStream();
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
    await openStream();
    scheduleRestart();
  });

  socket.on("stt:audio", (chunk: ArrayBuffer | Buffer) => {
    if (!stream) return;
    try {
      stream.write({ audio: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) });
    } catch { /* stream closing */ }
  });

  socket.on("stt:stop", stopStream);
  socket.on("disconnect", stopStream);
}
