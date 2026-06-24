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

async function warmUpMicrophone(): Promise<"ok" | "denied" | "not-found"> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return "ok";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((t) => t.stop());
    return "ok";
  } catch (e: unknown) {
    const err = e as DOMException;
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") return "denied";
    if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") return "not-found";
    return "ok";
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(",")[1]);
    };
    reader.readAsDataURL(blob);
  });
}

export function useSpeechRecognition({ lang = "ja-JP", onInterim, onFinal }: UseSpeechRecognitionOptions) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef(false);
  const langRef = useRef(lang);
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);

  // Stable flag: Web Speech API availability doesn't change during a session
  const useWebSpeech = useRef(getSpeechRecognition() !== null).current;

  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);

  // ── Web Speech API refs ────────────────────────────────────────────────────
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const startInternalRef = useRef<() => void>(() => {});

  // ── Google STT refs ────────────────────────────────────────────────────────
  const gstStreamRef = useRef<MediaStream | null>(null);

  // ── Google STT: transcribe one audio blob ──────────────────────────────────
  const transcribeBlob = useCallback(async (blob: Blob) => {
    if (blob.size < 1000) return;
    try {
      const base64 = await blobToBase64(blob);
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64, lang: langRef.current }),
      });
      const json = await res.json() as { transcript?: string };
      if (json.transcript) {
        onInterimRef.current?.("");
        onFinalRef.current?.(json.transcript);
      }
    } catch (e) {
      console.error("[GoogleSTT]", e);
    }
  }, []);

  // ── Google STT: record CHUNK_MS then transcribe, loop while active ─────────
  const startGstChunk = useCallback((stream: MediaStream) => {
    if (!activeRef.current) return;

    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: Blob[] = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: mimeType });
      await transcribeBlob(blob);
      if (activeRef.current) startGstChunk(stream);
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, 3000);
  }, [transcribeBlob]);

  // ── Web Speech API: core recognition instance ──────────────────────────────
  const startInternal = useCallback(() => {
    const SpeechRecognitionAPI = getSpeechRecognition();
    if (!SpeechRecognitionAPI) return;

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
      if (final) { onInterimRef.current?.(""); onFinalRef.current?.(final); }
    };

    rec.onend = () => {
      if (activeRef.current && recognitionRef.current === rec) {
        setTimeout(() => { if (activeRef.current) startInternalRef.current(); }, 200);
      } else if (!activeRef.current) {
        setListening(false);
      }
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      const err = event.error;
      if (err === "not-allowed") {
        setError("マイクへのアクセスが拒否されました。\nアドレスバー左端のアイコン →「マイク」→「許可」に変更し、ページをリロードしてください。");
        activeRef.current = false; setListening(false);
      } else if (err === "service-not-allowed") {
        setError("音声認識サービスを利用できません。\nインターネット接続を確認するか、Chromeのアドレスバー左端のアイコンから「マイク」と「音声」を許可してください。");
        activeRef.current = false; setListening(false);
      } else if (err === "network") {
        setError("ネットワークエラー: 音声認識にはインターネット接続が必要です。");
      } else if (err === "no-speech") {
        setError(null);
      } else if (err === "audio-capture") {
        setError("マイクが見つかりません。マイクの接続を確認してください。");
        activeRef.current = false; setListening(false);
      } else if (err === "aborted") {
        setError(null);
      } else {
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
        setTimeout(() => { if (activeRef.current) startInternalRef.current(); }, 600);
      } else {
        setListening(false);
      }
    }
  }, []);

  useEffect(() => { startInternalRef.current = startInternal; }, [startInternal]);

  // ── Public: start ──────────────────────────────────────────────────────────
  const start = useCallback(async (newLang?: string) => {
    if (newLang) langRef.current = newLang;
    setError(null);

    if (useWebSpeech) {
      // Chrome path: warm up getUserMedia then launch Web Speech API
      const prev = recognitionRef.current;
      recognitionRef.current = null;
      if (prev) { try { prev.stop(); } catch { /* ignore */ } }

      const warmup = await warmUpMicrophone();
      if (warmup === "denied") {
        setError("マイクへのアクセスが拒否されました。\nアドレスバー左端のアイコン →「マイク」→「許可」に変更し、ページをリロードしてください。");
        return;
      }
      if (warmup === "not-found") {
        setError("マイクが見つかりません。マイクの接続を確認してください。");
        return;
      }
      activeRef.current = true;
      setListening(true);
      setTimeout(() => { if (activeRef.current) startInternalRef.current(); }, 100);

    } else {
      // Edge / other browsers path: Google Cloud STT via MediaRecorder
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        gstStreamRef.current = stream;
        activeRef.current = true;
        setListening(true);
        startGstChunk(stream);
      } catch (e) {
        const err = e as DOMException;
        setError(
          err.name === "NotAllowedError"
            ? "マイクへのアクセスが拒否されました。ブラウザの設定でマイクを許可してください。"
            : "マイクへのアクセスに失敗しました。"
        );
      }
    }
  }, [useWebSpeech, startGstChunk]);

  // ── Public: stop ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;
    if (useWebSpeech) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.stop(); } catch { /* ignore */ }
    } else {
      gstStreamRef.current?.getTracks().forEach((t) => t.stop());
      gstStreamRef.current = null;
    }
    setListening(false);
    setError(null);
  }, [useWebSpeech]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      activeRef.current = false;
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.stop(); } catch { /* ignore */ }
      gstStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { start, stop, listening, supported: true, error };
}
