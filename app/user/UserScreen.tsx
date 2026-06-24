"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { PhoneCall, PhoneOff, Mic, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { ScreenShareView } from "@/components/ScreenShareView";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import type { TranscriptEntry } from "@/lib/types";
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
  const micOnRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const addEntry = useCallback((entry: Omit<TranscriptEntry, "id" | "timestamp">) => {
    setTranscript((prev) => [...prev, { ...entry, id: makeId(), timestamp: Date.now() }]);
  }, []);

  const langConfig = SUPPORTED_LANGS.find((l) => l.code === userLang);

  const { start: startMic, stop: stopMic, listening, error: micError } = useSpeechRecognition({
    lang: langConfig?.bcp47 ?? "ja-JP",
    onInterim: (text) => setInterimUser(text),
    onFinal: (text) => {
      // Reject if recognized text matches what the avatar just said (echo)
      const avatarText = lastAvatarTextRef.current;
      if (avatarText && text.replace(/\s/g, "") === avatarText.replace(/\s/g, "")) {
        setInterimUser("");
        return;
      }
      setInterimUser("");
      addEntry({ speaker: "user", text, isFinal: true });
      socketRef.current?.emit("speech:user", {
        sessionId: sessionIdRef.current,
        text,
        lang: userLangRef.current,
        isFinal: true,
      });
      // Auto-OFF mic after sending — user must press mic button again to speak
      stopMic();
      micOnRef.current = false;
    },
  });

  // Camera — auto-starts when call connects, streams frames to staff via screen:frame
  const { startCapture: startCamera, stopCapture: stopCamera } = useScreenCapture({
    fps: 5,
    quality: 0.6,
    width: 320,
    height: 240,
    onFrame: (frameData) => {
      if (sessionIdRef.current) {
        socketRef.current?.emit("screen:frame", { sessionId: sessionIdRef.current, frameData });
      }
    },
  });

  useEffect(() => {
    if (phase === "in-call") {
      startCamera("camera");
    } else {
      stopCamera();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

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
      // Clear echo detection ref: by the time user manually presses mic, TTS is done
      lastAvatarTextRef.current = "";
      micOnRef.current = true;
      startMic(langConfig?.bcp47);
    }
  }, [stopMic, startMic, langConfig]);

  // Track the most recent text the avatar spoke — used to filter echo
  const lastAvatarTextRef = useRef<string>("");

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

  // Space key shortcut: toggle mic (in-call only, not when typing in input)
  useEffect(() => {
    if (phase !== "in-call") return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      toggleMic();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [phase, toggleMic]);

  // Socket.IO setup
  useEffect(() => {
    const s = io({ path: "/socket.io", transports: ["websocket", "polling"] });
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
        setLatestStaffText(payload.text);
        setLatestAudio(undefined);
        staffSpeechKeyRef.current += 1;
        setStaffSpeechKey(staffSpeechKeyRef.current);
        lastAvatarTextRef.current = payload.text;
        // Auto-OFF mic when staff speaks — user must press mic button to respond
        stopMic();
        micOnRef.current = false;
        setInterimUser("");
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
      setStaffScreenFrame(payload.frameData || null);
    });

    return () => { s.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { userLangRef.current = userLang; }, [userLang]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, interimStaff]);

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
    <div
      className="h-screen flex overflow-hidden"
      style={{ background: "linear-gradient(180deg, #c5e9f8 0%, #9dd4ef 100%)" }}
    >
      {/* LEFT: title + chat + controls */}
      <div className="flex flex-col w-[58%] px-8 pt-8 pb-6 overflow-hidden">
        <h1 className="text-4xl font-bold text-gray-800 mb-5 shrink-0">
          ご用件をお伺いします。
        </h1>

        {/* Chat bubbles */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
          {transcript.map((entry) => (
            <div
              key={entry.id}
              className={`rounded-3xl px-7 py-4 text-2xl font-medium leading-snug max-w-[90%] shadow-sm ${
                entry.speaker === "user"
                  ? "bg-amber-300 text-gray-900"
                  : "bg-sky-200 text-gray-900"
              }`}
            >
              {entry.text}
            </div>
          ))}

          {interimStaff && (
            <div className="rounded-3xl px-7 py-4 text-2xl text-gray-400 italic max-w-[90%] bg-sky-100 shadow-sm">
              {interimStaff}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Bottom controls */}
        <div className="flex items-center gap-4 mt-6 shrink-0">
          <button
            onClick={endCall}
            className="flex items-center gap-2 px-7 py-4 bg-pink-400 hover:bg-pink-500 active:scale-95 text-white rounded-full text-xl font-semibold shadow-lg transition-all shrink-0"
          >
            <X size={24} />
            キャンセル
          </button>

          <button
            onClick={toggleMic}
            className="flex-1 flex items-center gap-4 bg-white rounded-2xl px-5 py-4 shadow-md hover:bg-gray-50 active:scale-[0.98] transition-all text-left"
          >
            <div
              className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 relative transition-colors ${
                listening ? "bg-pink-400" : "bg-gray-300"
              }`}
            >
              {listening && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-300 opacity-60 rounded-full" />
              )}
              <Mic size={22} className="text-white relative z-10" />
            </div>
            <div className="flex-1 overflow-hidden">
              {listening ? (
                <p className="text-lg text-gray-700 leading-relaxed line-clamp-2">
                  <span className="font-semibold">Listening...</span>
                  {interimUser && <span className="ml-2 text-gray-500">{interimUser}</span>}
                </p>
              ) : micError ? (
                <p className="text-base text-red-500">{micError}</p>
              ) : (
                <p className="text-gray-400 text-lg">
                  タップしてマイクをON
                  <span className="ml-2 text-sm opacity-60">[スペースキー]</span>
                </p>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* RIGHT: Screen share (when active) + Avatar */}
      <div className="w-[42%] flex flex-col bg-white/20">
        {staffScreenFrame && (
          <div className="p-4 pb-2 shrink-0">
            <ScreenShareView
              frameData={staffScreenFrame}
              label="スタッフ画面"
              className="h-52 w-full rounded-xl overflow-hidden border-2 border-sky-400"
            />
          </div>
        )}
        <div className="flex-1 flex items-end justify-center">
          <Avatar
            audioBase64={latestAudio}
            fallbackText={latestStaffText}
            fallbackKey={staffSpeechKey}
            fallbackLang={userLang}
            visible
            size="xl"
          />
        </div>
      </div>
    </div>
  );
}
