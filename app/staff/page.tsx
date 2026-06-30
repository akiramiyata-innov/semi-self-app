"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, Socket } from "socket.io-client";
import { Wifi, WifiOff, Monitor, Mic, ClipboardList, Users, ChevronDown } from "lucide-react";
import { CallQueueItem } from "@/components/CallQueueItem";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { Toast } from "@/components/Toast";
import type { ToastItem } from "@/components/Toast";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import type { TranscriptEntry } from "@/lib/types";
import type { LangCode, StaffStatus, StaffInfo } from "@/lib/socketEvents";

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

  // ── Multi-operation: staff presence ──────────────────────────────────────
  const staffNameRef = useRef("");
  const [staffName, setStaffName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [myStatus, setMyStatus] = useState<StaffStatus>("available");
  const [staffList, setStaffList] = useState<StaffInfo[]>([]);
  const [showStaffList, setShowStaffList] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sessionInfo, setSessionInfo] = useState<{ name: string; email: string; isAdmin: boolean } | null>(null);

  const addToast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/staff/login";
  }, []);

  // Check sessionStorage for saved name on mount (per-tab, not shared across tabs)
  useEffect(() => {
    const saved = sessionStorage.getItem("staffName");
    if (saved) {
      staffNameRef.current = saved;
      setStaffName(saved);
    }
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((info) => {
        if (info) {
          setSessionInfo(info);
          if (!saved && info.name) setNameInput(info.name);
        }
      })
      .catch(() => {});
  }, []);

  const submitName = useCallback(() => {
    const name = nameInput.trim();
    if (!name) return;
    sessionStorage.setItem("staffName", name);
    staffNameRef.current = name;
    setStaffName(name);
    socketRef.current?.emit("staff:join", { name });
  }, [nameInput]);

  const toggleStatus = useCallback(() => {
    const next: StaffStatus = myStatus === "available" ? "away" : "available";
    setMyStatus(next);
    socketRef.current?.emit("staff:setStatus", { status: next });
  }, [myStatus]);

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
  const { start: startMic, stop: stopMic, listening, error: micError, manualStop } = useSpeechRecognition({
    lang: "ja-JP",
    // Edge: 無音でOFFしたとき onFinal は発火しない → onStop で必ずセッションをクリア
    onStop: () => { activeListeningSession.current = null; },
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

      // Auto-OFF mic after sending — staff must press mic button again to speak
      stopMic();
      activeListeningSession.current = null;
      setActiveListeningId(null);
      micOnRef.current = false;
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
    const s = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => {
      setConnected(true);
      s.emit("staff:join", { name: staffNameRef.current || "スタッフ" });
    });
    s.on("disconnect", () => setConnected(false));

    s.on("staff:list", (payload: { staff: StaffInfo[] }) => {
      setStaffList(payload.staff);
      const me = payload.staff.find((sf) => sf.socketId === s.id);
      if (me) setMyStatus(me.status);
    });

    s.on("call:alreadyTaken", () => {
      addToast("別のスタッフが先に応答しました", "warning");
    });

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
    setMyStatus("busy"); // Optimistic: server confirms via staff:list
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
      // Chrome(Web Speech API): onFinal は同期的に発火済みか発火しない → 即座にクリア
      // Edge(Google STT): onFinal が非同期で後から発火するため onFinal 側でクリアする
      if (!manualStop) activeListeningSession.current = null;
      setActiveListeningId(null);
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

  // Space key shortcut: toggle mic (not when typing in input)
  // Uses refs so the handler is always registered once and reads latest values.
  const activeSessionsRef = useRef(activeSessions);
  useEffect(() => { activeSessionsRef.current = activeSessions; }, [activeSessions]);
  const toggleMicRef = useRef(toggleMic);
  useEffect(() => { toggleMicRef.current = toggleMic; }, [toggleMic]);
  const manualStopRef = useRef(manualStop);
  useEffect(() => { manualStopRef.current = manualStop; }, [manualStop]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      const currentSid = activeListeningSession.current;
      if (currentSid) {
        // Chrome(Web Speech API): マイクON中は Space で OFF にしない（onFinal で自動OFF）
        if (!manualStopRef.current) return;
        toggleMicRef.current(currentSid);
      } else {
        const firstSid = Array.from(activeSessionsRef.current.keys())[0];
        if (firstSid) toggleMicRef.current(firstSid);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleScreenShare = useCallback(async (sessionId: string) => {
    if (captureSessionRef.current === sessionId && capturing) {
      stopCapture();
      captureSessionRef.current = null;
      updateSession(sessionId, { isCapturing: false });
      socketRef.current?.emit("screen:share", { sessionId, frameData: "" });
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

  // Reset status to available when all sessions end
  useEffect(() => {
    if (activeSessions.size === 0 && myStatus === "busy") {
      setMyStatus("available");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessions.size]);

  // ── Derived state ─────────────────────────────────────────────────────────
  const pendingCalls = callQueue.filter((c) => !takenSessions.has(c.sessionId));
  const sessions = Array.from(activeSessions.values());

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">

      {/* ── 名前入力モーダル ────────────────────────────────────────────────── */}
      {staffName === null && (
        <div className="fixed inset-0 z-50 bg-blue-900/80 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-white rounded-2xl shadow-2xl p-8 w-80">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center mb-4">
              <span className="text-white text-sm font-bold">遠隔</span>
            </div>
            <h2 className="text-lg font-bold text-gray-900 mb-1">スタッフ名を入力</h2>
            <p className="text-sm text-gray-500 mb-5">キオスク画面に表示される名前です</p>
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitName()}
              placeholder="例：田中"
              autoFocus
              className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 mb-3"
            />
            <button
              onClick={submitName}
              disabled={!nameInput.trim()}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm font-medium rounded-lg transition-colors"
            >
              開始する
            </button>
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
        <div className="flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">遠隔</span>
            </div>
            <div>
              <h1 className="font-bold text-gray-900 text-sm">遠隔接客スタッフ画面</h1>
              <p className="text-xs text-gray-400">Remote Customer Service Console</p>
            </div>
          </div>

          {/* ── 自分のステータス ── */}
          <div className="flex items-center gap-2">
            {staffName && (
              <span className="text-sm font-medium text-gray-700 hidden sm:inline">{staffName}</span>
            )}
            <button
              onClick={myStatus !== "busy" ? toggleStatus : undefined}
              disabled={myStatus === "busy"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                myStatus === "available"
                  ? "bg-green-100 text-green-700 hover:bg-green-200 cursor-pointer"
                  : myStatus === "busy"
                  ? "bg-blue-100 text-blue-700 cursor-default"
                  : "bg-gray-100 text-gray-500 hover:bg-gray-200 cursor-pointer"
              }`}
              title={myStatus !== "busy" ? "クリックでステータス切替" : "通話中は変更できません"}
            >
              <span className={`w-2 h-2 rounded-full ${
                myStatus === "available" ? "bg-green-500" :
                myStatus === "busy" ? "bg-blue-500 animate-pulse" : "bg-gray-400"
              }`} />
              {myStatus === "available" ? "対応可" : myStatus === "busy" ? "対応中" : "離席"}
            </button>
          </div>

          {/* ── オンラインスタッフ ── */}
          <div className="relative">
            <button
              onClick={() => setShowStaffList((v) => !v)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <Users size={13} />
              {staffList.length}名オンライン
              <ChevronDown size={11} className={`transition-transform ${showStaffList ? "rotate-180" : ""}`} />
            </button>
            {showStaffList && (
              <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-40 py-2">
                {staffList.length === 0 ? (
                  <p className="text-xs text-gray-400 px-3 py-2">スタッフなし</p>
                ) : (
                  staffList.map((sf) => (
                    <div key={sf.socketId} className="flex items-center gap-2.5 px-3 py-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        sf.status === "available" ? "bg-green-500" :
                        sf.status === "busy" ? "bg-blue-500" : "bg-gray-400"
                      }`} />
                      <span className="text-sm text-gray-800 flex-1 truncate">
                        {sf.name}
                        {sf.socketId === socketRef.current?.id && (
                          <span className="text-gray-400 text-xs ml-1">(自分)</span>
                        )}
                      </span>
                      <span className="text-xs text-gray-400 shrink-0">
                        {sf.status === "available" ? "対応可" :
                         sf.status === "busy" ? `${sf.activeCalls}件対応中` : "離席"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* ── マイク許可確認 ── */}
          <button
            onClick={async () => {
              try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach((t) => t.stop());
                alert("✅ マイクの許可が確認できました。");
              } catch (e: unknown) {
                const err = e as DOMException;
                alert(`❌ マイクエラー: ${err.name}`);
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-300 text-xs font-medium rounded-lg transition-colors"
          >
            <Mic size={12} />
            マイク許可確認
          </button>

          {/* ── キオスク端末リンク ── */}
          <div className="flex items-center gap-1.5">
            {KIOSK_MACHINES.map((m) => (
              <a
                key={m.id}
                href={`/user?machine=${m.id}&name=${encodeURIComponent(m.name)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 px-2 py-1 bg-gray-100 hover:bg-blue-50 hover:text-blue-700 text-gray-600 text-xs rounded-lg border border-gray-200 hover:border-blue-300 transition-colors"
              >
                <Monitor size={11} />
                {m.name}
              </a>
            ))}
          </div>

          {/* ── ログ・接続状態 ── */}
          <div className="flex items-center gap-3 shrink-0">
            <Link
              href="/logs"
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition-colors"
            >
              <ClipboardList size={13} />
              通話ログ
            </Link>
            {sessionInfo?.isAdmin && (
              <Link
                href="/admin/staff"
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition-colors"
              >
                スタッフ管理
              </Link>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 px-3 py-1.5 text-red-500 hover:bg-red-50 text-xs font-medium rounded-lg transition-colors"
            >
              ログアウト
            </button>
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
                    // Auto-OFF mic after sending — staff must press mic button again to speak
                    stopMic();
                    activeListeningSession.current = null;
                    setActiveListeningId(null);
                    micOnRef.current = false;
                  }}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Toast notifications */}
      <Toast toasts={toasts} />
    </div>
  );
}
