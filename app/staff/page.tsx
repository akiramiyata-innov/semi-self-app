"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { Wifi, WifiOff, Monitor, Mic } from "lucide-react";
import { CallQueueItem } from "@/components/CallQueueItem";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import type { TranscriptEntry } from "@/components/TranscriptPanel";
import type { LangCode } from "@/lib/socketEvents";

interface IncomingCall {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang: LangCode;
  timestamp: number;
}

interface ActiveSession {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang: LangCode;
  transcript: TranscriptEntry[];
  interimUserText: string;
  interimStaffText: string;
  userCameraFrame: string | null;
  isListening: boolean;
  isCapturing: boolean;
}

// Kiosk machines available for demo
const KIOSK_MACHINES = [
  { id: "kiosk-1", name: "券売機1番" },
  { id: "kiosk-2", name: "券売機2番" },
  { id: "kiosk-3", name: "精算機1番" },
];

let entryCounter = 0;
function makeId() { return `s-${Date.now()}-${entryCounter++}`; }

function playBeep() {
  try {
    const ctx = new AudioContext();
    [880, 1100].forEach((freq, i) => {
      setTimeout(() => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }, i * 400);
    });
  } catch { /* ignore */ }
}

export default function StaffPage() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [callQueue, setCallQueue] = useState<IncomingCall[]>([]);
  const [takenSessions, setTakenSessions] = useState<Set<string>>(new Set());
  const [activeSessions, setActiveSessions] = useState<Map<string, ActiveSession>>(new Map());

  // ▶ Fix: use both ref (for callbacks) AND state (for re-renders)
  const activeListeningSession = useRef<string | null>(null);
  const [activeListeningId, setActiveListeningId] = useState<string | null>(null);
  const micOnRef = useRef(false);

  // ── Helpers ──────────────────────────────────────────────────────────────
  const updateSession = useCallback((sessionId: string, update: Partial<ActiveSession>) => {
    setActiveSessions((prev) => {
      const next = new Map(prev);
      const s = next.get(sessionId);
      if (s) next.set(sessionId, { ...s, ...update });
      return next;
    });
  }, []);

  // ── Speech Recognition ───────────────────────────────────────────────────
  const { start: startMic, stop: stopMic, listening, error: micError } = useSpeechRecognition({
    lang: "ja-JP",
    onInterim: (text) => {
      const sid = activeListeningSession.current;
      if (!sid) return;
      updateSession(sid, { interimStaffText: text });
      // ▶ Fix: also emit interim to server so user sees live typing
      socketRef.current?.emit("speech:staff", { sessionId: sid, text, isFinal: false });
    },
    onFinal: (text) => {
      const sid = activeListeningSession.current;
      if (!sid) return;

      setActiveSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(sid);
        if (session) {
          next.set(sid, {
            ...session,
            interimStaffText: "",
            transcript: [
              ...session.transcript,
              { id: makeId(), speaker: "staff", text, isFinal: true, timestamp: Date.now() },
            ],
          });
        }
        return next;
      });

      socketRef.current?.emit("speech:staff", { sessionId: sid, text, isFinal: true });
    },
  });

  // ── Screen Capture ───────────────────────────────────────────────────────
  const captureSessionRef = useRef<string | null>(null);

  const { startCapture, stopCapture, capturing } = useScreenCapture({
    fps: 5,
    quality: 0.6,
    onFrame: (frameData) => {
      const sid = captureSessionRef.current;
      if (sid) socketRef.current?.emit("screen:share", { sessionId: sid, frameData });
    },
  });

  // ── Visibility change: pause mic when tab goes to background ─────────────
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (micOnRef.current) stopMic();
      } else {
        if (micOnRef.current && activeListeningSession.current) startMic("ja-JP");
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopMic, startMic]);

  // ── Socket setup ─────────────────────────────────────────────────────────
  useEffect(() => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:3001";
    const s = io(socketUrl, { path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("staff:join");
    });
    s.on("disconnect", () => setConnected(false));

    s.on("call:incoming", (payload: IncomingCall) => {
      setCallQueue((prev) =>
        prev.some((c) => c.sessionId === payload.sessionId) ? prev : [...prev, payload]
      );
      playBeep();
    });

    s.on("call:taken", (payload: { sessionId: string }) => {
      setTakenSessions((prev) => new Set([...prev, payload.sessionId]));
    });

    s.on("call:ended", (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      setActiveSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      setCallQueue((prev) => prev.filter((c) => c.sessionId !== sessionId));
      if (activeListeningSession.current === sessionId) {
        stopMic();
        activeListeningSession.current = null;
        setActiveListeningId(null);
        micOnRef.current = false;
      }
      if (captureSessionRef.current === sessionId) {
        stopCapture();
        captureSessionRef.current = null;
      }
    });

    s.on(
      "speech:user",
      (payload: { sessionId: string; text: string; lang: LangCode; isFinal: boolean; translatedText?: string }) => {
        const { sessionId, text, translatedText, isFinal } = payload;
        if (!isFinal) {
          updateSession(sessionId, { interimUserText: text });
          return;
        }
        setActiveSessions((prev) => {
          const next = new Map(prev);
          const session = next.get(sessionId);
          if (session) {
            next.set(sessionId, {
              ...session,
              interimUserText: "",
              transcript: [
                ...session.transcript,
                { id: makeId(), speaker: "user", text, translatedText, isFinal: true, timestamp: Date.now() },
              ],
            });
          }
          return next;
        });
      }
    );

    s.on("screen:frame", (payload: { sessionId: string; frameData: string }) => {
      updateSession(payload.sessionId, { userCameraFrame: payload.frameData });
    });

    return () => { s.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────
  const answerCall = useCallback((call: IncomingCall) => {
    socketRef.current?.emit("call:answer", { sessionId: call.sessionId });
    setCallQueue((prev) => prev.filter((c) => c.sessionId !== call.sessionId));
    setTakenSessions((prev) => new Set([...prev, call.sessionId]));
    setActiveSessions((prev) => new Map([...prev, [call.sessionId, {
      sessionId: call.sessionId,
      machineId: call.machineId,
      machineName: call.machineName,
      userLang: call.userLang,
      transcript: [],
      interimUserText: "",
      interimStaffText: "",
      userCameraFrame: null,
      isListening: false,
      isCapturing: false,
    }]]));
  }, []);

  const rejectCall = useCallback((sessionId: string) => {
    socketRef.current?.emit("call:reject", { sessionId });
    setCallQueue((prev) => prev.filter((c) => c.sessionId !== sessionId));
    setTakenSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const endSession = useCallback((sessionId: string) => {
    socketRef.current?.emit("call:end", { sessionId });
    setActiveSessions((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    if (activeListeningSession.current === sessionId) {
      stopMic();
      activeListeningSession.current = null;
      setActiveListeningId(null);
      micOnRef.current = false;
    }
    if (captureSessionRef.current === sessionId) {
      stopCapture();
      captureSessionRef.current = null;
    }
  }, [stopMic, stopCapture]);

  const toggleMic = useCallback((sessionId: string) => {
    if (activeListeningSession.current === sessionId) {
      // Turn off
      stopMic();
      activeListeningSession.current = null;
      setActiveListeningId(null);  // ▶ Fix: update state so UI re-renders
      micOnRef.current = false;
    } else {
      // Turn off previous session's mic first
      if (activeListeningSession.current) {
        stopMic();
      }
      // Turn on this session
      activeListeningSession.current = sessionId;
      setActiveListeningId(sessionId);  // ▶ Fix: update state so UI re-renders
      micOnRef.current = true;
      startMic("ja-JP");
    }
  }, [stopMic, startMic]);

  const toggleScreenShare = useCallback(async (sessionId: string) => {
    if (captureSessionRef.current === sessionId && capturing) {
      stopCapture();
      captureSessionRef.current = null;
      updateSession(sessionId, { isCapturing: false });
    } else {
      // Stop previous capture if any
      if (captureSessionRef.current && captureSessionRef.current !== sessionId) {
        stopCapture();
        updateSession(captureSessionRef.current, { isCapturing: false });
      }
      captureSessionRef.current = sessionId;
      updateSession(sessionId, { isCapturing: true });
      await startCapture("display");
    }
  }, [capturing, stopCapture, startCapture, updateSession]);

  // ── Derived state ─────────────────────────────────────────────────────────
  const pendingCalls = callQueue.filter((c) => !takenSessions.has(c.sessionId));
  const sessions = Array.from(activeSessions.values());

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">遠隔</span>
            </div>
            <div>
              <h1 className="font-bold text-gray-900 text-sm">遠隔接客スタッフ画面</h1>
              <p className="text-xs text-gray-400">Remote Customer Service Console</p>
            </div>
          </div>

          {/* ▶ Mic permission test button — click to trigger getUserMedia dialog */}
          <button
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
                alert("✅ マイクの許可が確認できました。マイクONボタンが使えるようになります。");
              } catch (e: unknown) {
                const err = e as DOMException;
                alert(`❌ getUserMedia エラー\nname: ${err.name}\nmessage: ${err.message}`);
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 text-xs font-medium rounded-lg transition-colors"
            title="クリックしてマイク許可ダイアログを表示"
          >
            <Mic size={12} />
            マイク許可確認
          </button>

          {/* ▶ Kiosk machine links (from former landing page) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 mr-1 hidden sm:inline">キオスク端末:</span>
            {KIOSK_MACHINES.map((m) => (
              <a
                key={m.id}
                href={`/user?machine=${m.id}&name=${encodeURIComponent(m.name)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2.5 py-1 bg-gray-100 hover:bg-blue-50 hover:text-blue-700 text-gray-600 text-xs rounded-lg border border-gray-200 hover:border-blue-300 transition-colors"
              >
                <Monitor size={11} />
                {m.name}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-2">
            {connected ? (
              <span className="flex items-center gap-1.5 text-green-600 text-sm">
                <Wifi size={14} /> 接続中
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-red-500 text-sm">
                <WifiOff size={14} /> 切断中
              </span>
            )}
          </div>
        </div>

        {/* Mic error display */}
        {micError && (
          <div className="mt-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs whitespace-pre-line">
            ⚠️ {micError}
          </div>
        )}
      </header>

      {/* Call Queue */}
      {callQueue.length > 0 && (
        <div className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            着信キュー（{pendingCalls.length}件待機中）
          </p>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {callQueue.map((call) => (
              <div key={call.sessionId} className="min-w-72">
                <CallQueueItem
                  {...call}
                  taken={takenSessions.has(call.sessionId)}
                  onAnswer={() => answerCall(call)}
                  onReject={() => rejectCall(call.sessionId)}
                  userLang={call.userLang}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active sessions */}
      <div className="flex-1 overflow-hidden p-4">
        {sessions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4 text-2xl">📞</div>
            <p className="text-sm font-medium">通話待機中</p>
            <p className="text-xs mt-1">お客様からの呼び出しをお待ちください</p>
          </div>
        ) : (
          <div
            className={`h-full grid gap-4 ${
              sessions.length === 1 ? "grid-cols-1"
              : sessions.length === 2 ? "grid-cols-2"
              : "grid-cols-2 grid-rows-2"
            }`}
          >
            {sessions.map((session) => {
              // ▶ Fix: use activeListeningId (state) instead of ref for isListening prop
              const isListening = activeListeningId === session.sessionId && listening;
              return (
                <ActiveCallPanel
                  key={session.sessionId}
                  sessionId={session.sessionId}
                  machineName={session.machineName}
                  userLang={session.userLang}
                  transcript={session.transcript}
                  interimUserText={session.interimUserText}
                  interimStaffText={session.interimStaffText}
                  userCameraFrame={session.userCameraFrame}
                  isListening={isListening}
                  isCapturing={capturing && captureSessionRef.current === session.sessionId}
                  micError={micError}
                  onToggleMic={() => toggleMic(session.sessionId)}
                  onToggleScreenShare={() => toggleScreenShare(session.sessionId)}
                  onEnd={() => endSession(session.sessionId)}
                  onSendText={(text) => {
                    // Text input fallback: send as speech:staff final
                    setActiveSessions((prev) => {
                      const next = new Map(prev);
                      const s = next.get(session.sessionId);
                      if (s) {
                        next.set(session.sessionId, {
                          ...s,
                          interimStaffText: "",
                          transcript: [
                            ...s.transcript,
                            { id: makeId(), speaker: "staff", text, isFinal: true, timestamp: Date.now() },
                          ],
                        });
                      }
                      return next;
                    });
                    socketRef.current?.emit("speech:staff", { sessionId: session.sessionId, text, isFinal: true });
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
