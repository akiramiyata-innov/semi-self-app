"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

interface UseSpeechRecognitionOptions {
  lang?: string;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onStop?: () => void; // Edge: 録音停止時に必ず呼ばれる（無音でも）
  /** streaming時（NEXT_PUBLIC_STT_MODE=streaming）: ライブの Socket.IO 接続を返すゲッター */
  getSocket?: () => Socket | null;
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

export function useSpeechRecognition({ lang = "ja-JP", onInterim, onFinal, onStop, getSocket }: UseSpeechRecognitionOptions) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef(false);
  const langRef = useRef(lang);
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  const onStopRef = useRef(onStop);
  const getSocketRef = useRef(getSocket);

  // Edge has webkitSpeechRecognition but it fails with network errors — force Google STT
  const isEdge = typeof navigator !== "undefined" && /Edg\//.test(navigator.userAgent);
  const useWebSpeech = useRef(getSpeechRecognition() !== null && !isEdge).current;
  // Streaming STT (real-time + glossary + long-form) takes priority when enabled.
  // Falls back to the Web Speech / sync-Google paths otherwise.
  const streamingEnabled = process.env.NEXT_PUBLIC_STT_MODE === "streaming";

  useEffect(() => { langRef.current = lang; }, [lang]);
  useEffect(() => { onInterimRef.current = onInterim; }, [onInterim]);
  useEffect(() => { onFinalRef.current = onFinal; }, [onFinal]);
  useEffect(() => { onStopRef.current = onStop; }, [onStop]);
  useEffect(() => { getSocketRef.current = getSocket; }, [getSocket]);

  // ── Streaming STT refs ──────────────────────────────────────────────────────
  const sttCtxRef = useRef<AudioContext | null>(null);
  const sttNodeRef = useRef<AudioWorkletNode | null>(null);
  const sttStreamRef = useRef<MediaStream | null>(null);
  const sttOffRef = useRef<(() => void) | null>(null); // removes socket listeners

  // ── Web Speech API refs ────────────────────────────────────────────────────
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const startInternalRef = useRef<() => void>(() => {});

  // ── Google STT refs ────────────────────────────────────────────────────────
  const gstStreamRef = useRef<MediaStream | null>(null);
  const gstAudioContextRef = useRef<AudioContext | null>(null);
  const gstAnimFrameRef = useRef<number>(0);
  const gstCurrentRecorderRef = useRef<MediaRecorder | null>(null);

  // ── Google STT: transcribe one audio blob ──────────────────────────────────
  const transcribeBlob = useCallback(async (blob: Blob) => {
    if (blob.size < 500) return;
    try {
      const base64 = await blobToBase64(blob);
      const res = await fetch("/api/stt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio: base64, lang: langRef.current }),
      });
      const json = await res.json() as { transcript?: string; error?: string };
      if (json.transcript) {
        onInterimRef.current?.("");
        onFinalRef.current?.(json.transcript);
      }
    } catch (e) {
      console.error("[GoogleSTT]", e);
    }
  }, []);

  // ── Google STT: 手動ON/OFF（Push-to-Talk）────────────────────────────────
  const startGstManual = useCallback((stream: MediaStream) => {
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "audio/webm";

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, { mimeType });
    gstCurrentRecorderRef.current = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size >= 500) await transcribeBlob(blob);
      // 音声あり・なしに関わらず必ず呼ぶ（無音OFFでも activeListeningSession をクリアするため）
      onStopRef.current?.();
    };
    recorder.start(200);
  }, [transcribeBlob]);

  // ── Streaming STT: mic → AudioWorklet(16kHz PCM) → Socket.IO → Google ───────
  const stopStreaming = useCallback(() => {
    const socket = getSocketRef.current?.();
    socket?.emit("stt:stop");
    sttOffRef.current?.();
    sttOffRef.current = null;
    try { sttNodeRef.current?.disconnect(); } catch { /* ignore */ }
    sttNodeRef.current = null;
    sttStreamRef.current?.getTracks().forEach((t) => t.stop());
    sttStreamRef.current = null;
    const ctx = sttCtxRef.current;
    sttCtxRef.current = null;
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    onStopRef.current?.();
  }, []);

  const startStreaming = useCallback(async () => {
    const socket = getSocketRef.current?.();
    if (!socket) { setError("サーバーに接続できていません。少し待って再度お試しください。"); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      sttStreamRef.current = stream;
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC({ sampleRate: 16000 });
      sttCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/stt-worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "stt-processor");
      sttNodeRef.current = node;
      node.port.onmessage = (e: MessageEvent) => { socket.emit("stt:audio", e.data); };
      source.connect(node);
      // Pull the graph so the worklet runs, but keep it silent (no mic playback).
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);

      const onInterim = (p: { transcript?: string }) => { if (activeRef.current) onInterimRef.current?.(p.transcript ?? ""); };
      const onFinal = (p: { transcript?: string }) => {
        if (activeRef.current && p.transcript) { onInterimRef.current?.(""); onFinalRef.current?.(p.transcript); }
      };
      const onErr = (p: { message?: string }) => { setError(p?.message ? `音声認識エラー: ${p.message}` : "音声認識エラー"); };
      socket.on("stt:interim", onInterim);
      socket.on("stt:final", onFinal);
      socket.on("stt:error", onErr);
      sttOffRef.current = () => {
        socket.off("stt:interim", onInterim);
        socket.off("stt:final", onFinal);
        socket.off("stt:error", onErr);
      };

      socket.emit("stt:start", { lang: langRef.current });
      activeRef.current = true;
      setListening(true);
    } catch (e) {
      const err = e as DOMException;
      setError(
        err.name === "NotAllowedError"
          ? "マイクへのアクセスが拒否されました。ブラウザの設定でマイクを許可してください。"
          : "マイクへのアクセスに失敗しました。"
      );
      stopStreaming();
    }
  }, [stopStreaming]);

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

    if (streamingEnabled) {
      await startStreaming();
    } else if (useWebSpeech) {
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
      // Edge / other browsers path: Google Cloud STT（手動ON/OFF）
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        gstStreamRef.current = stream;
        activeRef.current = true;
        setListening(true);
        startGstManual(stream);
      } catch (e) {
        const err = e as DOMException;
        setError(
          err.name === "NotAllowedError"
            ? "マイクへのアクセスが拒否されました。ブラウザの設定でマイクを許可してください。"
            : "マイクへのアクセスに失敗しました。"
        );
      }
    }
  }, [streamingEnabled, startStreaming, useWebSpeech, startGstManual]);

  // ── Public: stop ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;
    if (streamingEnabled) {
      stopStreaming();
    } else if (useWebSpeech) {
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.stop(); } catch { /* ignore */ }
    } else {
      const rec = gstCurrentRecorderRef.current;
      const stream = gstStreamRef.current;
      gstCurrentRecorderRef.current = null;
      gstStreamRef.current = null;
      if (rec?.state !== "inactive") {
        rec?.stop();
      } else {
        console.log(`[D5] recorder既にinactive → stream手動停止`);
        stream?.getTracks().forEach((t) => t.stop());
      }
    }
    setListening(false);
    setError(null);
  }, [streamingEnabled, stopStreaming, useWebSpeech]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      activeRef.current = false;
      gstCurrentRecorderRef.current?.stop();
      const rec = recognitionRef.current;
      recognitionRef.current = null;
      try { rec?.stop(); } catch { /* ignore */ }
      gstStreamRef.current?.getTracks().forEach((t) => t.stop());
      // streaming teardown
      sttOffRef.current?.();
      sttNodeRef.current?.disconnect();
      sttStreamRef.current?.getTracks().forEach((t) => t.stop());
      const ctx = sttCtxRef.current;
      if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    };
  }, []);

  // manualStop=true → streaming / Edge・GST（手動ON/OFF）、false → Chrome（onFinal で自動OFF）
  return { start, stop, listening, supported: true, error, manualStop: streamingEnabled || !useWebSpeech };
}
