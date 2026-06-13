"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { PhoneCall, PhoneOff, Mic, MicOff, Send } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { ScreenShareView } from "@/components/ScreenShareView";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import type { TranscriptEntry } from "@/components/TranscriptPanel";
import type { LangCode } from "@/lib/socketEvents";

type Phase = "lang-select" | "idle" | "calling" | "in-call" | "ended" | "rejected";

let entryCounter = 0;
function makeId() { return `e-${Date.now()}-${entryCounter++}`; }

interface UserScreenProps {
  machineId: string;
  machineName: string;
}

export function UserScreen({ machineId, machineName }: UserScreenProps) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>("lang-select");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userLang, setUserLang] = useState<LangCode>("ja");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interimUser, setInterimUser] = useState("");
  const [interimStaff, setInterimStaff] = useState("");

  // TTS state: prefer Google TTS base64, fallback to Web Speech Synthesis
  const [latestAudio, setLatestAudio] = useState<string | undefined>(undefined);
  const [latestStaffText, setLatestStaffText] = useState<string>("");
  // Increments each time a new final staff message arrives — even if text is identical.
  // Passed to Avatar as fallbackKey so Web Speech Synthesis always fires.
  const [staffSpeechKey, setStaffSpeechKey] = useState<number | undefined>(undefined);
  const staffSpeechKeyRef = useRef(0);

  const [staffScreenFrame, setStaffScreenFrame] = useState<string | null>(null);
  const [inputText, setInputText] = useState("");

  const sessionIdRef = useRef<string | null>(null);
  const userLangRef = useRef<LangCode>("ja");
  // Track "user wants mic on" separately from the hook's listening state
  // (needed for visibilitychange: we resume if mic was intentionally on)
  const micOnRef = useRef(false);

  const addEntry = useCallback((entry: Omit<TranscriptEntry, "id" | "timestamp">) => {
    setTranscript((prev) => [...prev, { ...entry, id: makeId(), timestamp: Date.now() }]);
  }, []);

  const langConfig = SUPPORTED_LANGS.find((l) => l.code === userLang);

  const { start: startMic, stop: stopMic, listening, error: micError } = useSpeechRecognition({
    lang: langConfig?.bcp47 ?? "ja-JP",
    onInterim: (text) => setInterimUser(text),
    onFinal: (text) => {
      setInterimUser("");
      addEntry({ speaker: "user", text, isFinal: true });
      socketRef.current?.emit("speech:user", {
        sessionId: sessionIdRef.current,
        text,
        lang: userLangRef.current,
        isFinal: true,
      });
    },
  });

  // If speech recognition encounters a fatal error, reset micOnRef too
  useEffect(() => {
    if (micError && (
      micError.includes("拒否") || micError.includes("見つかりません")
    )) {
      micOnRef.current = false;
    }
  }, [micError]);

  const toggleMic = useCallback(() => {
    if (micOnRef.current) {
      stopMic();
      micOnRef.current = false;
    } else {
      micOnRef.current = true;
      startMic(langConfig?.bcp47);
    }
  }, [stopMic, startMic, langConfig]);

  // Pause mic when tab goes to background (prevents cross-tab audio pickup)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (micOnRef.current) stopMic();
      } else {
        if (micOnRef.current) startMic(langConfig?.bcp47);
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopMic, startMic, langConfig]);

  // Socket.IO setup
  useEffect(() => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";
    const s = io(socketUrl, { path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = s;
    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));

    s.on("call:answered", (payload: { sessionId: string }) => {
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      setPhase("in-call");
    });

    s.on("call:rejected", () => {
      // Staff declined — show message briefly then return to lang-select
      setPhase("rejected");
      setTimeout(() => setPhase("lang-select"), 3000);
    });

    s.on("call:ended", () => {
      setPhase("ended");
      stopMic();
      micOnRef.current = false;
      // Return to lang-select after 3 seconds
      setTimeout(() => {
        setPhase("lang-select");
        setTranscript([]);
        setSessionId(null);
        sessionIdRef.current = null;
        setStaffScreenFrame(null);
        setLatestAudio(undefined);
        setLatestStaffText("");
        setInterimStaff("");
      }, 3000);
    });

    s.on("speech:staff", (payload: { text: string; isFinal: boolean }) => {
      if (payload.isFinal) {
        setInterimStaff("");
        addEntry({ speaker: "staff", text: payload.text, isFinal: true });
        // Store for Web Speech Synthesis fallback
        setLatestStaffText(payload.text);
        // Reset latestAudio so the next tts:audio triggers the effect
        setLatestAudio(undefined);
        // Increment key so Avatar's fallback effect always fires — even for repeated text
        staffSpeechKeyRef.current += 1;
        setStaffSpeechKey(staffSpeechKeyRef.current);
      } else {
        setInterimStaff(payload.text);
      }
    });

    s.on("tts:audio", (payload: { audioBase64: string }) => {
      if (payload.audioBase64) {
        setLatestAudio(payload.audioBase64);
        // Clear fallback text to avoid double-speaking
        setLatestStaffText("");
      }
    });

    s.on("screen:share", (payload: { frameData: string }) => {
      setStaffScreenFrame(payload.frameData);
    });

    return () => { s.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { userLangRef.current = userLang; }, [userLang]);

  const selectLang = (code: LangCode) => {
    setUserLang(code);
    setPhase("idle");
  };

  const callStaff = () => {
    if (!connected) return;
    setPhase("calling");
    socketRef.current?.emit("call:request", { machineId, machineName, userLang });
  };

  const endCall = () => {
    socketRef.current?.emit("call:end", { sessionId });
  };

  const sendTextMessage = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    setInputText("");
    setInterimUser("");
    addEntry({ speaker: "user", text, isFinal: true });
    socketRef.current?.emit("speech:user", {
      sessionId: sessionIdRef.current,
      text,
      lang: userLangRef.current,
      isFinal: true,
    });
  }, [inputText, addEntry]);

  // --- Lang Select ---
  if (phase === "lang-select") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center p-8">
        <div className="text-center mb-10">
          <h1 className="text-2xl font-bold text-white mb-2">{machineName}</h1>
          <p className="text-blue-200">言語をお選びください / Please select your language</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 max-w-xl w-full">
          {SUPPORTED_LANGS.map((l) => (
            <button
              key={l.code}
              onClick={() => selectLang(l.code)}
              className="flex flex-col items-center gap-2 bg-white/10 hover:bg-white/25 active:scale-95 rounded-2xl p-6 transition-all text-white border border-white/20 hover:border-white/40"
            >
              <span className="text-4xl">{l.flag}</span>
              <span className="text-sm font-medium">{l.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // --- Idle ---
  if (phase === "idle") {
    return (
      <div className="min-h-screen bg-gradient-to-b from-blue-800 to-blue-900 flex flex-col items-center justify-center p-8">
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-white mb-1">{machineName}</h1>
          <p className="text-blue-300 text-sm flex items-center justify-center gap-2">
            {connected ? "接続中" : "接続待機中..."}
            <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-gray-400"}`} />
          </p>
        </div>
        <button
          onClick={callStaff}
          disabled={!connected}
          className="w-64 h-64 rounded-full bg-green-500 hover:bg-green-400 active:scale-95 disabled:bg-gray-500 text-white flex flex-col items-center justify-center gap-3 shadow-2xl transition-all text-xl font-bold"
        >
          <PhoneCall size={48} />
          <span>係員を呼ぶ</span>
          <span className="text-base font-normal opacity-80">Call Staff</span>
        </button>
        <button
          onClick={() => setPhase("lang-select")}
          className="mt-6 text-blue-300 text-sm hover:text-white transition-colors"
        >
          言語を変更 / Change language
        </button>
      </div>
    );
  }

  // --- Calling ---
  if (phase === "calling") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6">
        <div className="w-24 h-24 rounded-full bg-green-500/20 flex items-center justify-center">
          <PhoneCall className="text-green-400 animate-pulse" size={40} />
        </div>
        <p className="text-white text-xl font-semibold">係員を呼び出し中...</p>
        <p className="text-blue-300 text-sm">しばらくお待ちください</p>
      </div>
    );
  }

  // --- Rejected ---
  if (phase === "rejected") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6">
        <div className="w-24 h-24 rounded-full bg-orange-500/20 flex items-center justify-center">
          <PhoneOff className="text-orange-400" size={40} />
        </div>
        <p className="text-white text-xl font-semibold">現在対応できません</p>
        <p className="text-blue-300 text-sm">申し訳ございません。しばらく後に再度お試しください。</p>
      </div>
    );
  }

  // --- Ended ---
  if (phase === "ended") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6">
        <div className="w-24 h-24 rounded-full bg-gray-500/20 flex items-center justify-center">
          <PhoneOff className="text-gray-400" size={40} />
        </div>
        <p className="text-white text-xl font-semibold">対話終了</p>
        <p className="text-blue-300 text-sm">ありがとうございました</p>
      </div>
    );
  }

  // --- In-Call ---
  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 shrink-0">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
          <span className="text-gray-200 text-sm">{machineName} — 通話中</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">{SUPPORTED_LANGS.find((l) => l.code === userLang)?.label}</span>
          <button
            onClick={toggleMic}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-sm ${
              listening ? "bg-blue-600 text-white" : "bg-gray-600 text-gray-300"
            }`}
          >
            {listening ? <Mic size={14} /> : <MicOff size={14} />}
            {listening ? "マイクON" : "マイクOFF"}
          </button>
          <button
            onClick={endCall}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white text-sm rounded-lg transition-colors"
          >
            <PhoneOff size={14} />
            対話終了
          </button>
        </div>
      </div>

      {/* Mic error — shown inline below top bar */}
      {micError && (
        <div className="bg-red-900/80 border-b border-red-700 px-4 py-2 text-red-200 text-xs shrink-0 whitespace-pre-line">
          ⚠️ {micError}
        </div>
      )}

      {/* Main */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Avatar section */}
          <div className="bg-gray-800 flex items-center justify-center py-6 shrink-0">
            <Avatar
              audioBase64={latestAudio}
              fallbackText={latestStaffText}
              fallbackKey={staffSpeechKey}
              fallbackLang={userLang}
              visible
              size="lg"
            />
          </div>

          {/* Staff screen share — shown prominently below avatar when active */}
          {staffScreenFrame && (
            <div className="bg-gray-900 border-t-2 border-blue-500 shrink-0 p-2">
              <ScreenShareView
                frameData={staffScreenFrame}
                label="スタッフ共有画面 / Staff Screen"
                className="h-48 w-full"
              />
            </div>
          )}

          {/* Transcript */}
          <div className="flex-1 overflow-hidden bg-white">
            <TranscriptPanel
              entries={transcript}
              interimUserText={interimUser}
              interimStaffText={interimStaff}
            />
          </div>

          {/* Text input fallback */}
          <div className="border-t border-gray-700 bg-gray-800 px-4 py-3 shrink-0">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") sendTextMessage(); }}
                placeholder={listening ? "マイクON（テキスト入力も可）" : "テキストで送信（マイクの代わりに使用可）"}
                className="flex-1 text-sm px-3 py-2 rounded-lg bg-gray-700 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-400"
              />
              <button
                onClick={sendTextMessage}
                disabled={!inputText.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white text-sm rounded-lg transition-colors"
              >
                <Send size={14} />
                送信
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
