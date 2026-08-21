"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";

// 一時停止中に実音声の代わりに送る無音チャンク（100ms分・16kHz/16bit＝全ゼロ）。
// 毎回同じものを送ってよい（送信時に複製されるため使い回しで問題ない）。
const SILENT_CHUNK = new ArrayBuffer(3200);

/**
 * マイク／音声認識のエラー種別。**文言ではなくコードを返す**のは、お客様画面では
 * お客様が選んだ言語で、係員画面では日本語で出す必要があるため。表示文言は
 * 画面側が持つ（お客様画面＝8言語、係員画面＝日本語）。
 */
export type MicErrorCode =
  | "mic-denied"          // マイクの使用を許可されていない
  | "mic-not-found"       // マイクが見つからない
  | "network"             // ネットワークが必要／届かない
  | "service-unavailable" // 音声認識サービスを利用できない
  | "no-connection"       // サーバーに接続できていない
  | "unknown";            // それ以外

/**
 * 確定テキストに添える情報（v1.51.0）。
 * continuation＝分割確定＝認識エンジンが1つの発話を2つに分けて確定したときの2つ目
 * （サーバーの無音ゲートが判定した印）。受け手は「直前の自分の発言の続き」として扱える。
 * ストリーミング方式以外（Edge の録音方式・Web Speech）では付かない。
 */
export interface SttFinalMeta {
  continuation?: boolean;
  /** 話し始めの時刻（サーバーの時計・v1.52.0）。画面と記録の並び順に使う。 */
  spokeAt?: number;
}

interface UseSpeechRecognitionOptions {
  lang?: string;
  onInterim?: (text: string) => void;
  onFinal?: (text: string, meta?: SttFinalMeta) => void;
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
  const [error, setError] = useState<MicErrorCode | null>(null);
  // 技術的な詳細（係員画面にだけ添える。お客様には出さない）
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

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
  // 開始/停止の競合防止: stop() で世代を進め、進行中の startStreaming を無効化する。
  // （素早いON/OFFで stt:stop → stt:start の順が逆転し、音声の来ないストリームが
  //   サーバー側に残ってタイムアウトエラーになるのを防ぐ）
  const sttGenRef = useRef(0);
  // 一時停止（ミュート）。マイクや認識ストリームは動かしたまま、送る音だけを無音に
  // 差し替える。アバターの読み上げのたびに本当に止めて張り直すと、開通待ちの頭欠けや
  // 開始/停止の競合（v1.30.4の類）が起きるため、頻繁な一時停止はこの方式で行う。
  // 無音を送り続けるので、サーバーの無音ゲートが結果を捨て、Google側の
  // 「音声が来ない」タイムアウトも起きない。
  const sttMutedRef = useRef(false);
  const [muted, setMutedState] = useState(false);
  const setMuted = useCallback((m: boolean) => {
    // 変わり目だけコンソールに残す（v1.50.0）。「お客様の声が届かない」調査で
    // 一時停止が戻っていないことを端末側で確かめられるように（英語S5の52秒無音）。
    if (sttMutedRef.current !== m) console.log(`[mic] ${m ? "一時停止（無音を送る）" : "再開"}`);
    sttMutedRef.current = m;
    setMutedState(m);
  }, []);
  const sttListenerSocketRef = useRef<Socket | null>(null); // リスナー登録済みソケット
  const sttDrainTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sttStartingRef = useRef(false); // getUserMedia 取得中か（完了前の多重取得を防ぐ）
  const sttWantRef = useRef(false);     // マイクをONにしたい状態か（Space連打時、最後に押した状態を保持）
  const startStreamingRef = useRef<() => void>(() => {}); // finally からの再開用（自己参照を避ける）

  // ── Web Speech API refs ────────────────────────────────────────────────────
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const startInternalRef = useRef<() => void>(() => {});

  // ── Google STT refs ────────────────────────────────────────────────────────
  const gstStreamRef = useRef<MediaStream | null>(null);
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
  // 受信リスナーはソケットごとに1回だけ登録して常設する（開始のたびに登録すると、
  // 短時間のON/OFFで重複登録＝テキスト二重表示の原因になる）。確定(final)は停止直後に
  // 遅れて届くことがあるため、activeRef に関係なく常に届ける（話し終わりの文字消え対策）。
  const ensureSttListeners = useCallback((socket: Socket) => {
    if (sttListenerSocketRef.current === socket) return;
    sttOffRef.current?.(); // 旧ソケットのリスナーを掃除（再接続時）
    const onInterim = (p: { transcript?: string }) => { if (activeRef.current) onInterimRef.current?.(p.transcript ?? ""); };
    const onFinal = (p: { transcript?: string; continuation?: boolean; spokeAt?: number }) => {
      if (p.transcript) {
        onInterimRef.current?.("");
        onFinalRef.current?.(p.transcript, { continuation: !!p.continuation, spokeAt: typeof p.spokeAt === "number" ? p.spokeAt : undefined });
      }
    };
    const onErr = (p: { message?: string }) => {
      if (activeRef.current) { setError("unknown"); setErrorDetail(p?.message ?? null); }
    };
    socket.on("stt:interim", onInterim);
    socket.on("stt:final", onFinal);
    socket.on("stt:error", onErr);
    sttListenerSocketRef.current = socket;
    sttOffRef.current = () => {
      socket.off("stt:interim", onInterim);
      socket.off("stt:final", onFinal);
      socket.off("stt:error", onErr);
      sttListenerSocketRef.current = null;
    };
  }, []);

  const stopStreaming = useCallback(() => {
    sttGenRef.current++; // 進行中の startStreaming を無効化
    const socket = getSocketRef.current?.();
    const wasCapturing = !!(sttNodeRef.current || sttStreamRef.current || sttCtxRef.current);
    socket?.emit("stt:stop");
    try { sttNodeRef.current?.disconnect(); } catch { /* ignore */ }
    sttNodeRef.current = null;
    sttStreamRef.current?.getTracks().forEach((t) => t.stop());
    sttStreamRef.current = null;
    const ctx = sttCtxRef.current;
    sttCtxRef.current = null;
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    if (!wasCapturing) return; // 多重呼び出し（既に停止済み）
    // 遅れて届く確定テキスト(stt:final)を3秒待ってから onStop（リスナーは常設のまま）。
    if (sttDrainTimerRef.current) clearTimeout(sttDrainTimerRef.current);
    sttDrainTimerRef.current = setTimeout(() => {
      sttDrainTimerRef.current = null;
      onStopRef.current?.();
    }, 3000);
  }, []);

  const startStreaming = useCallback(async () => {
    const socket = getSocketRef.current?.();
    if (!socket) { setError("no-connection"); setErrorDetail(null); return; }
    // 稼働中、または取得処理が進行中なら何もしない。マイク取得(getUserMedia)は完了まで一瞬
    // かかるため、この「取得中」も弾かないと、Space連打時に同じマイクを二重取得しようとして
    // OSが一時的に掴めず（NotReadableError等）、実害のない偽エラーが表示されてしまう。
    if (sttStreamRef.current || sttStartingRef.current) return;
    if (sttDrainTimerRef.current) { clearTimeout(sttDrainTimerRef.current); sttDrainTimerRef.current = null; }
    const gen = ++sttGenRef.current;
    sttStartingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sttGenRef.current !== gen) { stream.getTracks().forEach((t) => t.stop()); return; } // 開始中に停止された
      sttStreamRef.current = stream;
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC({ sampleRate: 16000 });
      sttCtxRef.current = ctx;
      await ctx.audioWorklet.addModule("/stt-worklet.js");
      if (sttGenRef.current !== gen) return; // 停止済み（後始末は stopStreaming が実施済み）
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "stt-processor");
      sttNodeRef.current = node;
      node.port.onmessage = (e: MessageEvent) => {
        socket.emit("stt:audio", sttMutedRef.current ? SILENT_CHUNK : e.data);
      };
      source.connect(node);
      // Pull the graph so the worklet runs, but keep it silent (no mic playback).
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);

      ensureSttListeners(socket);
      socket.emit("stt:start", { lang: langRef.current });
      activeRef.current = true;
      setListening(true);
    } catch (e) {
      // この試行が停止/再開で無効化されていれば（Space連打で開く⇄閉じるが重なった等）、
      // 偽のエラーは出さず黙って回復させる。本物の失敗だけをエラー表示する。
      if (sttGenRef.current !== gen) return;
      sttWantRef.current = false; // 本物の失敗 → 再開ループを止める（利用者が再度ONにするまで待つ）
      const err = e as DOMException;
      setError(err.name === "NotAllowedError" ? "mic-denied" : "unknown");
      setErrorDetail(err.name === "NotAllowedError" ? null : err.name);
      stopStreaming();
    } finally {
      sttStartingRef.current = false;
      // 取得中に状態が変わっていたら（連打で最後に「入」だがまだ掴めていない 等）、最後に押した
      // 状態へ合わせ直す。start/stopStreaming は多重防止済みなので再入しても安全。
      if (sttWantRef.current) {
        if (!sttStreamRef.current) startStreamingRef.current();
      } else if (sttStreamRef.current) {
        stopStreaming();
      }
    }
  }, [stopStreaming, ensureSttListeners]);
  useEffect(() => { startStreamingRef.current = () => { void startStreaming(); }; }, [startStreaming]);

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
      setError(null); setErrorDetail(null);
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
        setError("mic-denied"); setErrorDetail(null);
        activeRef.current = false; setListening(false);
      } else if (err === "service-not-allowed") {
        setError("service-unavailable"); setErrorDetail(null);
        activeRef.current = false; setListening(false);
      } else if (err === "network") {
        setError("network"); setErrorDetail(null);
      } else if (err === "no-speech") {
        setError(null); setErrorDetail(null);
      } else if (err === "audio-capture") {
        setError("mic-not-found"); setErrorDetail(null);
        activeRef.current = false; setListening(false);
      } else if (err === "aborted") {
        setError(null); setErrorDetail(null);
      } else {
        setError("unknown"); setErrorDetail(String(err));
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
    setError(null); setErrorDetail(null);

    if (streamingEnabled) {
      sttWantRef.current = true; // マイクON希望を記録（連打時、取得中に状態が変わっても最終状態へ合わせる）
      await startStreaming();
    } else if (useWebSpeech) {
      // Chrome path: warm up getUserMedia then launch Web Speech API
      const prev = recognitionRef.current;
      recognitionRef.current = null;
      if (prev) { try { prev.stop(); } catch { /* ignore */ } }

      const warmup = await warmUpMicrophone();
      if (warmup === "denied") {
        setError("mic-denied"); setErrorDetail(null);
        return;
      }
      if (warmup === "not-found") {
        setError("mic-not-found"); setErrorDetail(null);
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
        setError(err.name === "NotAllowedError" ? "mic-denied" : "unknown");
        setErrorDetail(err.name === "NotAllowedError" ? null : err.name);
      }
    }
  }, [streamingEnabled, startStreaming, useWebSpeech, startGstManual]);

  // ── Public: stop ───────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    activeRef.current = false;
    // 一時停止はマイク停止で必ず解除（次のONを無音のまま始めない）
    sttMutedRef.current = false;
    setMutedState(false);
    if (streamingEnabled) {
      sttWantRef.current = false; // マイクOFF希望を記録
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
    setError(null); setErrorDetail(null);
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
      sttGenRef.current++;
      if (sttDrainTimerRef.current) clearTimeout(sttDrainTimerRef.current);
      sttOffRef.current?.();
      sttNodeRef.current?.disconnect();
      sttStreamRef.current?.getTracks().forEach((t) => t.stop());
      const ctx = sttCtxRef.current;
      if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
    };
  }, []);

  // manualStop=true → streaming / Edge・GST（手動ON/OFF）、false → Chrome（onFinal で自動OFF）
  // muted / setMuted はストリーミング方式のみ有効（他方式では常に false のまま）。
  return { start, stop, listening, muted, setMuted, supported: true, error, errorDetail, manualStop: streamingEnabled || !useWebSpeech };
}
