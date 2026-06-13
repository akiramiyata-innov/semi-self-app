"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseSpeechRecognitionOptions {
  lang?: string;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Chrome treats webkitSpeechRecognition and getUserMedia as SEPARATE permissions.
 * Requesting mic via getUserMedia first "warms up" the permission so that
 * webkitSpeechRecognition can reuse it without a separate denied-state.
 */
async function warmUpMicrophone(): Promise<"ok" | "denied" | "not-found"> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "ok";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Release immediately — we only needed the permission grant
    stream.getTracks().forEach((t) => t.stop());
    return "ok";
  } catch (e: unknown) {
    const err = e as DOMException;
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") return "denied";
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") return "not-found";
    return "ok"; // other errors — still try speech recognition
  }
}

export function useSpeechRecognition({ lang = "ja-JP", onInterim, onFinal }: UseSpeechRecognitionOptions) {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const activeRef = useRef(false);
  const langRef = useRef(lang);
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  const [listening, setListening] = useState(false);
  const [supported] = useState(() => getSpeechRecognition() !== null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);

  // Stored as a ref so onend closures always call the latest version
  const startInternalRef = useRef<() => void>(() => {});

  /**
   * Creates a brand-new SpeechRecognition instance and starts it.
   * NEVER reuses a previous instance — avoids Chrome's "already started /
   * transitional state" errors that cause silent failures.
   */
  const startInternal = useCallback(() => {
    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) return;

    // Detach and silently discard the previous recognition without calling abort()
    // on it — calling abort() on a recently-ended instance can fire spurious events.
    recognitionRef.current = null;

    const rec = new SpeechRecognitionAPI();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = langRef.current;
    rec.maxAlternatives = 1;
    recognitionRef.current = rec;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      setError(null);
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const t = event.results[i][0].transcript;
        if (event.results[i].isFinal) { final += t; } else { interim += t; }
      }
      if (interim) onInterimRef.current?.(interim);
      if (final) {
        onInterimRef.current?.("");
        onFinalRef.current?.(final);
      }
    };

    rec.onend = () => {
      // Restart only when:
      //  • we still intend to be listening (activeRef)
      //  • this specific instance is still the current one (not superseded by stop/start)
      if (activeRef.current && recognitionRef.current === rec) {
        setTimeout(() => {
          if (activeRef.current) startInternalRef.current();
        }, 200);
      } else if (!activeRef.current) {
        setListening(false);
      }
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      const err = event.error;

      if (err === "not-allowed") {
        // Permission was explicitly denied (user clicked Block, or Chrome policy)
        setError(
          "マイクへのアクセスが拒否されました。\n" +
          "アドレスバー左端のアイコン →「マイク」→「許可」に変更し、ページをリロードしてください。"
        );
        activeRef.current = false;
        setListening(false);

      } else if (err === "service-not-allowed") {
        // Speech recognition service is unavailable (HTTP non-localhost, policy, or network)
        setError(
          "音声認識サービスを利用できません。\n" +
          "インターネット接続を確認するか、Chromeのアドレスバー左端のアイコンから「マイク」と「音声」を許可してください。"
        );
        activeRef.current = false;
        setListening(false);

      } else if (err === "network") {
        // Transient network error — recognition will restart via onend
        setError("ネットワークエラー: 音声認識にはインターネット接続が必要です。");

      } else if (err === "no-speech") {
        // Normal timeout (no speech detected in the window) — onend will restart
        setError(null);

      } else if (err === "audio-capture") {
        setError("マイクが見つかりません。マイクの接続を確認してください。");
        activeRef.current = false;
        setListening(false);

      } else if (err === "aborted") {
        // Deliberate stop — not an error
        setError(null);

      } else {
        // Show raw error code so we can diagnose unknown errors
        setError(`音声認識エラー: ${err}`);
        console.warn("[SpeechRecognition] unhandled error:", err);
      }
    };

    try {
      rec.start();
    } catch (e) {
      console.error("[SpeechRecognition] start() threw:", e);
      recognitionRef.current = null;
      if (activeRef.current) {
        // Retry with a fresh instance after a longer pause
        setTimeout(() => { if (activeRef.current) startInternalRef.current(); }, 600);
      } else {
        setListening(false);
      }
    }
  }, []); // intentionally empty — all mutable values accessed via refs

  useEffect(() => { startInternalRef.current = startInternal; }, [startInternal]);

  /**
   * Public API: request mic permission via getUserMedia first (warms up the
   * permission grant so webkitSpeechRecognition sees it as already-allowed),
   * then start recognition.
   */
  const start = useCallback(async (newLang?: string) => {
    if (newLang) langRef.current = newLang;
    setError(null);

    // Stop any in-progress recognition before requesting getUserMedia
    // so Chrome doesn't see two simultaneous mic consumers.
    const prev = recognitionRef.current;
    recognitionRef.current = null;
    if (prev) {
      try { prev.stop(); } catch { /* ignore */ }
    }

    // Warm up: request mic via getUserMedia before webkitSpeechRecognition
    const warmup = await warmUpMicrophone();
    if (warmup === "denied") {
      setError(
        "マイクへのアクセスが拒否されました。\n" +
        "アドレスバー左端のアイコン →「マイク」→「許可」に変更し、ページをリロードしてください。"
      );
      return;
    }
    if (warmup === "not-found") {
      setError("マイクが見つかりません。マイクの接続を確認してください。");
      return;
    }

    activeRef.current = true;
    setListening(true);
    // Small pause so Chrome finishes releasing the getUserMedia stream
    setTimeout(() => { if (activeRef.current) startInternalRef.current(); }, 100);
  }, []); // intentionally empty — all mutable values accessed via refs or startInternalRef

  const stop = useCallback(() => {
    activeRef.current = false;
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    try { rec?.stop(); } catch { /* ignore */ }
    setListening(false);
    setError(null);
  }, []);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.stop(); } catch { /* ignore */ }
    };
  }, []);

  return { start, stop, listening, supported, error };
}
