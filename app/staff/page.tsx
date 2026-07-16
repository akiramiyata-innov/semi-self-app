"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, Socket } from "socket.io-client";
import { Wifi, WifiOff, Monitor, Mic, ClipboardList, Users, ChevronDown, Mail, LogOut, MapPin, KeyRound, BookOpen, Map as MapIcon } from "lucide-react";
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
  userCameraFaceFrame: string | null;
  isListening: boolean;
  isCapturing: boolean;
}

// Kiosk machines available for demo
const KIOSK_MACHINES = [
  { id: "kiosk-1", name: "券売機1番" },
  { id: "kiosk-2", name: "券売機2番" },
  { id: "kiosk-3", name: "精算機1番" },
];

// メニュー有効フラグ（false = 表示はするがクリック不可・薄いグレー、true = 通常リンク）
// 後で戻すときは true に変更するだけ
const CALL_LOGS_ENABLED = false;      // 通話ログ
const GLOSSARY_ADMIN_ENABLED = false; // 用語集管理

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
  // Face-camera preview for calls still ringing (not yet answered) — sessionId → frameData
  const [previewFaceFrames, setPreviewFaceFrames] = useState<Map<string, string>>(new Map());

  // ▶ Fix: use both ref (for callbacks) AND state (for re-renders)
  const activeListeningSession = useRef<string | null>(null);
  const [activeListeningId, setActiveListeningId] = useState<string | null>(null);
  const micOnRef = useRef(false);

  // ── Multi-operation: staff presence ──────────────────────────────────────
  const staffNameRef = useRef("");
  const uidRef = useRef("");
  const myStationIdsRef = useRef<string[]>([]);
  const [staffName, setStaffName] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [myStatus, setMyStatus] = useState<StaffStatus>("available");
  const [staffList, setStaffList] = useState<StaffInfo[]>([]);
  const [showStaffList, setShowStaffList] = useState(false);
  const [showKioskMenu, setShowKioskMenu] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sessionInfo, setSessionInfo] = useState<{ uid: string; name: string; email: string; isAdmin: boolean } | null>(null);

  // 担当駅設定パネル
  const [showSettings, setShowSettings] = useState(false);
  const [stations, setStations] = useState<Array<{ id: string; name: string; code?: string }>>([]);
  const [myStationIds, setMyStationIds] = useState<string[]>([]);
  const [savingStations, setSavingStations] = useState(false);
  // PW変更
  const [showPwForm, setShowPwForm] = useState(false);
  const [newPw, setNewPw] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg] = useState("");

  const addToast = useCallback((message: string, type: ToastItem["type"] = "info") => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/staff/login";
  }, []);

  // initialDataLoaded: sessionInfo・担当駅が両方揃ったら true
  const [initialDataLoaded, setInitialDataLoaded] = useState(false);

  // Check sessionStorage for saved name on mount (per-tab, not shared across tabs)
  useEffect(() => {
    const saved = sessionStorage.getItem("staffName");
    if (saved) {
      staffNameRef.current = saved;
      setStaffName(saved);
    }
    Promise.all([
      fetch("/api/auth/me").then((r) => r.json()).catch(() => null),
      fetch("/api/staff/assignments/me").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/stations").then((r) => r.json()).catch(() => null),
    ]).then(([info, assignments, stationsData]) => {
      if (info) {
        setSessionInfo(info);
        uidRef.current = info.uid ?? "";
        if (!saved && info.name) setNameInput(info.name);
      }
      if (assignments?.stationIds) {
        setMyStationIds(assignments.stationIds);
        myStationIdsRef.current = assignments.stationIds;
      }
      if (stationsData?.stations) setStations(stationsData.stations);
      setInitialDataLoaded(true);
    });
  }, []);

  // ソケット接続済み かつ 初期データ取得完了 → staff:join を送信。
  // 担当駅が読み込まれる前に空配列で登録して「全駅対応(=制限なし)」扱いになる
  // フェイルオープンを防ぐため、初期データが揃うまで登録しない（再接続時もここで再登録）。
  useEffect(() => {
    if (!connected || !initialDataLoaded) return;
    socketRef.current?.emit("staff:join", {
      name: staffNameRef.current || "スタッフ",
      uid: uidRef.current,
      stationIds: myStationIdsRef.current,
    });
  }, [connected, initialDataLoaded]);

  // S5: periodic session expiry check (every 5 minutes)
  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await fetch("/api/auth/me");
        if (res.status === 401) {
          addToast("セッションが切れました。再ログインしてください。", "error");
          setTimeout(() => { window.location.href = "/staff/login"; }, 3000);
        }
      } catch {
        // network error — ignore, don't log out on transient failure
      }
    };
    const timer = setInterval(checkSession, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [addToast]);

  const submitName = useCallback(() => {
    const name = nameInput.trim();
    if (!name) return;
    sessionStorage.setItem("staffName", name);
    staffNameRef.current = name;
    setStaffName(name);
    socketRef.current?.emit("staff:join", { name, uid: sessionInfo?.uid ?? "", stationIds: myStationIdsRef.current });
  }, [nameInput, sessionInfo]);

  const saveMyStations = useCallback(async () => {
    setSavingStations(true);
    await fetch("/api/staff/assignments/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stationIds: myStationIds }),
    });
    setSavingStations(false);
    setShowSettings(false);
    myStationIdsRef.current = myStationIds;
    socketRef.current?.emit("staff:updateStations", { stationIds: myStationIds });
  }, [myStationIds, sessionInfo]);

  const savePw = useCallback(async () => {
    if (newPw.length < 8) { setPwMsg("8文字以上で入力してください"); return; }
    setSavingPw(true); setPwMsg("");
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: newPw }),
    });
    if (res.ok) { setPwMsg("変更しました"); setNewPw(""); setShowPwForm(false); }
    else { const d = await res.json(); setPwMsg(d.error ?? "変更に失敗しました"); }
    setSavingPw(false);
  }, [newPw]);

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
    getSocket: () => socketRef.current,
    // Edge/streaming: 無音でOFFしたとき onFinal は発火しない → onStop で必ずセッションをクリア
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
      // staff:join is emitted by the initialDataLoaded effect (not here), so we
      // never register with an empty station list before assignments have loaded.
      setConnected(true);
    });
    s.on("disconnect", () => setConnected(false));

    s.on("staff:list", (payload: { staff: StaffInfo[] }) => {
      setStaffList(payload.staff);
      const me = payload.staff.find((sf) => sf.socketId === s.id);
      if (me) setMyStatus(me.status);
    });

    s.on("call:alreadyTaken", (payload: { sessionId: string }) => {
      addToast("別のスタッフが先に応答しました", "warning");
      // Roll back the optimistic session answerCall created, otherwise this staff
      // keeps a live ghost panel for a call another staff owns (their mic/text
      // would reach the customer). Mirror the call:ended cleanup.
      const { sessionId } = payload;
      setActiveSessions((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      setPreviewFaceFrames((prev) => {
        if (!prev.has(sessionId)) return prev;
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
      // myStatus reverts to "available" automatically once activeSessions empties
      // (see the activeSessions.size effect) and is confirmed by staff:list.
    });

    // S1: user's connection dropped unexpectedly
    s.on("call:userDisconnected", (payload: { sessionId: string; machineName: string }) => {
      addToast(`${payload.machineName}のユーザーとの接続が切れました`, "error");
    });

    // S4: translation failed
    s.on("error:translation", (payload: { sessionId: string; direction: string }) => {
      const msg = payload.direction === "jaToUser"
        ? "翻訳に失敗しました。お客様へのメッセージが原文（日本語）で送信されました。"
        : "翻訳に失敗しました。お客様のメッセージを翻訳できませんでした。";
      addToast(msg, "error");
    });

    s.on("call:incoming", (payload: IncomingCall) => {
      setCallQueue((prev) =>
        prev.some((c) => c.sessionId === payload.sessionId) ? prev : [...prev, payload]
      );
      playBeep();
    });

    s.on("call:taken", (payload: { sessionId: string }) => {
      setTakenSessions((prev) => new Set([...prev, payload.sessionId]));
      setPreviewFaceFrames((prev) => {
        if (!prev.has(payload.sessionId)) return prev;
        const next = new Map(prev);
        next.delete(payload.sessionId);
        return next;
      });
    });

    s.on("call:ended", (payload: { sessionId: string }) => {
      const { sessionId } = payload;
      setActiveSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      setCallQueue((prev) => prev.filter((c) => c.sessionId !== sessionId));
      setPreviewFaceFrames((prev) => {
        if (!prev.has(sessionId)) return prev;
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

    s.on("screen:frame", (payload: { sessionId: string; frameData: string; camera?: "face" | "hand" }) => {
      // The hand camera is no longer shown to staff — ignore its frames.
      if (payload.camera === "hand") return;
      // Face (券面) frames can arrive before the call is answered; keep them keyed by
      // sessionId so the in-call view has no blank flash on answer.
      setPreviewFaceFrames((prev) => {
        const next = new Map(prev);
        next.set(payload.sessionId, payload.frameData);
        return next;
      });
      updateSession(payload.sessionId, { userCameraFaceFrame: payload.frameData });
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
      // Carry over the ringing-preview face frame so there's no blank flash on answer
      userCameraFaceFrame: previewFaceFrames.get(call.sessionId) ?? null,
      isListening: false,
      isCapturing: false,
    }]]));
  }, [previewFaceFrames]);

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

          {/* ── 右側：ステータス・オンライン・接続・メニュー ── */}
          <div className="flex items-center gap-2 min-w-0">
            {/* 自分のステータス */}
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

            {/* オンラインスタッフ */}
            <div className="relative">
              <button
                onClick={() => { setShowStaffList((v) => !v); setShowKioskMenu(false); setShowAccountMenu(false); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Users size={13} />
                <span className="hidden sm:inline">{staffList.length}名</span>
                <ChevronDown size={11} className={`transition-transform ${showStaffList ? "rotate-180" : ""}`} />
              </button>
              {showStaffList && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowStaffList(false)} />
                  <div className="absolute right-0 top-full mt-1.5 w-60 bg-white border border-gray-200 rounded-xl shadow-lg z-40 py-2">
                    <p className="text-[11px] font-semibold text-gray-400 px-3 pb-1.5">オンラインスタッフ</p>
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
                </>
              )}
            </div>

            {/* 接続状態 */}
            <span className="hidden sm:flex items-center gap-1.5 text-sm shrink-0" title={connected ? "サーバーに接続中" : "サーバーから切断"}>
              {connected
                ? <><Wifi size={14} className="text-green-600" /><span className="text-green-600 hidden md:inline">接続中</span></>
                : <><WifiOff size={14} className="text-red-500" /><span className="text-red-500 hidden md:inline">切断中</span></>}
            </span>

            <span className="w-px h-6 bg-gray-200 mx-0.5 hidden sm:block" />

            {/* キオスク画面を開く */}
            <div className="relative">
              <button
                onClick={() => { setShowKioskMenu((v) => !v); setShowStaffList(false); setShowAccountMenu(false); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg transition-colors"
              >
                <Monitor size={13} />
                <span className="hidden sm:inline">キオスク</span>
                <ChevronDown size={11} className={`transition-transform ${showKioskMenu ? "rotate-180" : ""}`} />
              </button>
              {showKioskMenu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowKioskMenu(false)} />
                  <div className="absolute right-0 top-full mt-1.5 w-52 bg-white border border-gray-200 rounded-xl shadow-lg z-40 py-2">
                    <p className="text-[11px] font-semibold text-gray-400 px-3 pb-1.5">キオスク画面を開く（別タブ）</p>
                    {KIOSK_MACHINES.map((m) => (
                      <a
                        key={m.id}
                        href={`/user?machine=${m.id}&name=${encodeURIComponent(m.name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setShowKioskMenu(false)}
                        className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <Monitor size={14} className="text-gray-400" />
                        {m.name}
                      </a>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* アカウントメニュー */}
            <div className="relative">
              <button
                onClick={() => { setShowAccountMenu((v) => !v); setShowStaffList(false); setShowKioskMenu(false); }}
                className="flex items-center gap-2 pl-1.5 pr-2 py-1 rounded-lg hover:bg-gray-100 transition-colors"
                title="アカウント・設定メニュー"
              >
                <span className="w-7 h-7 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
                  {(staffName?.[0] ?? sessionInfo?.name?.[0] ?? "?").toUpperCase()}
                </span>
                <span className="text-sm font-medium text-gray-700 hidden md:inline max-w-[120px] truncate">{staffName ?? "スタッフ"}</span>
                <ChevronDown size={12} className={`text-gray-400 transition-transform ${showAccountMenu ? "rotate-180" : ""}`} />
              </button>
              {showAccountMenu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setShowAccountMenu(false)} />
                  <div className="absolute right-0 top-full mt-1.5 w-64 bg-white border border-gray-200 rounded-xl shadow-lg z-40 overflow-hidden">
                    {/* アカウント情報 */}
                    <div className="px-3.5 py-3 border-b border-gray-100 bg-gray-50">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-gray-800 truncate">{staffName ?? "スタッフ"}</p>
                        {sessionInfo?.isAdmin && (
                          <span className="text-[10px] font-bold text-purple-600 bg-purple-100 px-1.5 py-0.5 rounded shrink-0">管理者</span>
                        )}
                      </div>
                      {sessionInfo?.email && (
                        <p className="flex items-center gap-1 text-xs text-gray-400 mt-0.5">
                          <Mail size={11} className="shrink-0" />
                          <span className="truncate">{sessionInfo.email}</span>
                        </p>
                      )}
                    </div>
                    {/* メニュー項目 */}
                    <div className="py-1">
                      <button
                        onClick={async () => {
                          setShowAccountMenu(false);
                          try {
                            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                            stream.getTracks().forEach((t) => t.stop());
                            alert("✅ マイクの許可が確認できました。");
                          } catch (e: unknown) {
                            const err = e as DOMException;
                            alert(`❌ マイクエラー: ${err.name}`);
                          }
                        }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <Mic size={15} className="text-gray-400" /> マイク許可確認
                      </button>
                      {CALL_LOGS_ENABLED ? (
                        <Link
                          href="/logs"
                          onClick={() => setShowAccountMenu(false)}
                          className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                        >
                          <ClipboardList size={15} className="text-gray-400" /> 通話ログ
                        </Link>
                      ) : (
                        <div
                          className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-300 cursor-not-allowed select-none"
                          title="現在ご利用いただけません"
                        >
                          <ClipboardList size={15} className="text-gray-300" /> 通話ログ
                        </div>
                      )}
                      <button
                        onClick={() => { setShowSettings(true); setShowPwForm(false); setShowAccountMenu(false); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <MapPin size={15} className="text-gray-400" /> 担当駅設定
                      </button>
                      <button
                        onClick={() => { setShowPwForm(true); setShowSettings(false); setPwMsg(""); setNewPw(""); setShowAccountMenu(false); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <KeyRound size={15} className="text-gray-400" /> パスワード変更
                      </button>
                      {sessionInfo?.isAdmin && (
                        <>
                          <div className="my-1 border-t border-gray-100" />
                          <p className="text-[11px] font-semibold text-gray-400 px-3.5 py-1">管理者メニュー</p>
                          <Link
                            href="/admin/staff"
                            onClick={() => setShowAccountMenu(false)}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                          >
                            <Users size={15} className="text-gray-400" /> スタッフ管理
                          </Link>
                          <Link
                            href="/admin/stations"
                            onClick={() => setShowAccountMenu(false)}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                          >
                            <MapIcon size={15} className="text-gray-400" /> 駅マスター登録
                          </Link>
                          {GLOSSARY_ADMIN_ENABLED ? (
                            <Link
                              href="/admin/glossary"
                              onClick={() => setShowAccountMenu(false)}
                              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                              <BookOpen size={15} className="text-gray-400" /> 用語集管理
                            </Link>
                          ) : (
                            <div
                              className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-300 cursor-not-allowed select-none"
                              title="現在ご利用いただけません"
                            >
                              <BookOpen size={15} className="text-gray-300" /> 用語集管理
                            </div>
                          )}
                        </>
                      )}
                      <div className="my-1 border-t border-gray-100" />
                      <button
                        onClick={() => { setShowAccountMenu(false); handleLogout(); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors text-left"
                      >
                        <LogOut size={15} /> ログアウト
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {micError && (
          <div className="mt-2 px-3 py-1.5 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs whitespace-pre-line">
            ⚠️ {micError}
          </div>
        )}

        {/* 担当駅設定パネル */}
        {showSettings && (
          <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-xs font-semibold text-blue-700 mb-2">担当駅を選択（複数可）</p>
            {stations.length === 0 ? (
              <p className="text-xs text-gray-400">駅が登録されていません。管理者に駅マスターの登録を依頼してください。</p>
            ) : (
              <div className="grid grid-cols-3 gap-1.5 mb-2">
                {stations.map((s) => (
                  <label key={s.id} className="flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={myStationIds.includes(s.id)}
                      onChange={() => setMyStationIds((prev) =>
                        prev.includes(s.id) ? prev.filter((id) => id !== s.id) : [...prev, s.id]
                      )}
                      className="w-3.5 h-3.5 accent-blue-600"
                    />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={saveMyStations} disabled={savingStations} className="px-3 py-1 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {savingStations ? "保存中..." : "保存"}
              </button>
              <button onClick={() => setShowSettings(false)} className="px-3 py-1 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white">
                閉じる
              </button>
            </div>
          </div>
        )}

        {/* PW変更パネル */}
        {showPwForm && (
          <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-xs font-semibold text-amber-700 mb-2">パスワードを変更</p>
            {sessionInfo?.email && (
              <p className="text-xs text-gray-500 mb-2">対象アカウント：{sessionInfo.email}</p>
            )}
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="新しいパスワード（8文字以上）"
                className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
              <button onClick={savePw} disabled={savingPw} className="px-3 py-1 bg-amber-500 text-white text-xs rounded-lg hover:bg-amber-600 disabled:opacity-50 shrink-0">
                {savingPw ? "変更中..." : "変更"}
              </button>
              <button onClick={() => setShowPwForm(false)} className="px-3 py-1 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white shrink-0">
                閉じる
              </button>
            </div>
            {pwMsg && <p className={`text-xs mt-1 ${pwMsg.includes("変更しました") ? "text-green-600" : "text-red-500"}`}>{pwMsg}</p>}
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
                  userCameraFaceFrame={session.userCameraFaceFrame}
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
