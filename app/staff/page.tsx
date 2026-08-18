"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { io, Socket } from "socket.io-client";
import { Wifi, WifiOff, Monitor, Mic, ClipboardList, Users, ChevronDown, Mail, LogOut, MapPin, KeyRound, BookOpen, Map as MapIcon, MessageSquare, Download, AlertTriangle } from "lucide-react";
import { CallQueueItem } from "@/components/CallQueueItem";
import { ActiveCallPanel } from "@/components/ActiveCallPanel";
import { Toast } from "@/components/Toast";
import type { ToastItem } from "@/components/Toast";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import type { MicErrorCode } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import { installClientErrorReporter } from "@/lib/clientErrorReporter";
import { getSharedAudioContext } from "@/lib/audioUnlock";
import { UserAudioPlayer } from "@/lib/userAudioPlayer";
import { APP_VERSION } from "@/lib/appVersion";
import type { TranscriptEntry } from "@/lib/types";
import type { LangCode, StaffStatus, StaffInfo } from "@/lib/socketEvents";

interface IncomingCall {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang: LangCode;
  timestamp: number;
}

// マイク／音声認識のエラー文言（係員向け・日本語）。フックはコードだけを返すので、
// 画面ごとに言語を割り当てる。係員はブラウザ設定を直せるため手順まで書く。
const MIC_ERR_JA: Record<MicErrorCode, string> = {
  "mic-denied": "マイクへのアクセスが拒否されました。\nアドレスバー左端のアイコン →「マイク」→「許可」に変更し、ページをリロードしてください。",
  "mic-not-found": "マイクが見つかりません。マイクの接続を確認してください。",
  "network": "ネットワークエラー: 音声認識にはインターネット接続が必要です。",
  "service-unavailable": "音声認識サービスを利用できません。\nインターネット接続を確認するか、Chromeのアドレスバー左端のアイコンから「マイク」と「音声」を許可してください。",
  "no-connection": "サーバーに接続できていません。少し待って再度お試しください。",
  "unknown": "音声認識エラーが発生しました。",
};

/** お客様側のマイク異常を係員に見せるための文言（原因は端末側なので手順は書かない）。 */
const USER_MIC_ERR_JA: Record<MicErrorCode, string> = {
  "mic-denied": "お客様の端末でマイクが許可されていません",
  "mic-not-found": "お客様の端末でマイクが見つかりません",
  "network": "お客様側の通信が不安定です",
  "service-unavailable": "お客様側で音声認識を利用できません",
  "no-connection": "お客様がサーバーに接続できていません",
  "unknown": "お客様側で音声認識のエラーが発生しています",
};

interface ActiveSession {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang: LangCode;
  transcript: TranscriptEntry[];
  interimUserText: string;
  interimStaffText: string;
  userCameraFaceFrame: string | null;
  /** 券面カメラの映像が最後に届いた時刻。途絶（映像なし）表示の判定に使う。 */
  userCameraFaceFrameAt: number | null;
  /** お客様側から申告されたカメラ異常の説明（無ければnull）。「映像なし」の枠に出す。 */
  userCameraError: string | null;
  isListening: boolean;
  isCapturing: boolean;
  /** お客様が今話しているか（音量で判定。確定テキストが出るまで点灯し続ける）。 */
  userSpeaking: boolean;
  /** お客様の画面に会話のテキストが出ているか（既定は非表示）。係員側からも切り替えられる。 */
  textVisible: boolean;
  /** お客様側のマイク異常（null＝異常なし）。係員が原因を切り分けられるようにする。 */
  userMicError: MicErrorCode | null;
  /** お客様マイクの今の状態。on=聞き取り中／paused=読み上げ中の自動一時停止／off=OFF。 */
  userMicState: "on" | "paused" | "off";
  /** お客様の生の声をこの画面で鳴らしているか（v1.42.0・既定はOFF）。 */
  listenUserAudio: boolean;
}

// Kiosk machines available for demo
const KIOSK_MACHINES = [
  { id: "kiosk-1", name: "券売機1番" },
  { id: "kiosk-2", name: "券売機2番" },
  { id: "kiosk-3", name: "精算機1番" },
];

// メニュー有効フラグ（false = 表示はするがクリック不可・薄いグレー、true = 通常リンク）
// 後で戻すときは true に変更するだけ
const CALL_LOGS_ENABLED = true;      // 通話ログ
const GLOSSARY_ADMIN_ENABLED = true; // 用語集管理

// ストリーミングSTT時は、スタッフも「連続入力」（確定ごとにマイクを自動OFFしない）。
const STREAMING = process.env.NEXT_PUBLIC_STT_MODE === "streaming";

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

  // マイクテスト（接客前の音量チェック）
  const [showMicTest, setShowMicTest] = useState(false);
  const [micLevel, setMicLevel] = useState(0); // 0-100
  const [micTestErr, setMicTestErr] = useState<string | null>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestCtxRef = useRef<AudioContext | null>(null);
  const micTestRafRef = useRef<number | null>(null);

  // マイクテストパネルの開閉に合わせて音量メーターを起動/停止
  useEffect(() => {
    if (!showMicTest) return;
    let cancelled = false;
    setMicTestErr(null);
    setMicLevel(0);
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        micTestStreamRef.current = stream;
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new Ctx();
        micTestCtxRef.current = ctx;
        await ctx.resume().catch(() => {});
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / data.length); // 0..1
          setMicLevel(Math.min(100, Math.round(rms * 300)));
          micTestRafRef.current = requestAnimationFrame(tick);
        };
        micTestRafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        const err = e as DOMException;
        setMicTestErr(err?.name || "不明なエラー");
      }
    })();
    return () => {
      cancelled = true;
      if (micTestRafRef.current) cancelAnimationFrame(micTestRafRef.current);
      micTestRafRef.current = null;
      micTestStreamRef.current?.getTracks().forEach((t) => t.stop());
      micTestStreamRef.current = null;
      micTestCtxRef.current?.close().catch(() => {});
      micTestCtxRef.current = null;
      setMicLevel(0);
    };
  }, [showMicTest]);

  // 定型文（よく使う文をボタン1つで送信・スタッフ個人用・サーバー保存）
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [qrDraft, setQrDraft] = useState<string[]>([]); // 設定パネルを開いている間の編集用コピー
  const [savingQr, setSavingQr] = useState(false);
  const [qrSaved, setQrSaved] = useState(false); // 直近の保存が成功したか（「保存しました」表示用）

  const saveQuickReplies = useCallback(async () => {
    setSavingQr(true);
    const cleaned = qrDraft.map((s) => s.trim()).filter((s) => s.length > 0);
    const res = await fetch("/api/staff/quick-replies/me", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrases: cleaned }),
    }).then((r) => r.json()).catch(() => null);
    const saved = res?.phrases ?? cleaned;
    setSavingQr(false);
    setQuickReplies(saved);
    setQrDraft(saved); // サーバーで正規化（重複・空文字除去）した内容を編集欄にも反映
    setQrSaved(true); // パネルは閉じない。「閉じる」を押したときだけ閉じる
  }, [qrDraft]);

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

  // 認証情報・担当駅を取得。表示名は「登録アカウント名」を強制使用する（スタッフが
  // 自由に名乗れると、メールと違う名前で表示される問題があったため。改ざん防止）。
  useEffect(() => {
    Promise.all([
      fetch("/api/auth/me").then((r) => r.json()).catch(() => null),
      fetch("/api/staff/assignments/me").then((r) => r.json()).catch(() => null),
      fetch("/api/admin/stations").then((r) => r.json()).catch(() => null),
      fetch("/api/staff/quick-replies/me").then((r) => r.json()).catch(() => null),
    ]).then(([info, assignments, stationsData, quickReplyData]) => {
      if (!info?.uid) {
        // 有効なセッションが無い → ログインへ（名前入力画面は出さない）
        window.location.href = "/staff/login";
        return;
      }
      setSessionInfo(info);
      uidRef.current = info.uid;
      // 登録名（Firebase 表示名）を表示名として使用。未設定時のみメールで代替。
      const registeredName = (info.name || info.email || "スタッフ").trim();
      staffNameRef.current = registeredName;
      setStaffName(registeredName);
      if (assignments?.stationIds) {
        setMyStationIds(assignments.stationIds);
        myStationIdsRef.current = assignments.stationIds;
      }
      if (stationsData?.stations) setStations(stationsData.stations);
      if (Array.isArray(quickReplyData?.phrases)) setQuickReplies(quickReplyData.phrases);
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

  // ── お客様の声を聞く（v1.42.0）─────────────────────────────────────────────
  // お客様の音声は音声認識のためにサーバーへ届いており、これまでは文字にしたら
  // 捨てていた。同じ音を担当係員にも配って耳で聞けるようにする。文字起こしの
  // 弱点（取り逃し・数秒の遅れ・同音の書き間違い）を、そのまま補うのが狙い。
  /** 通話ごとの再生装置。ONにした通話の分だけ作り、終わったら片付ける。 */
  const audioPlayersRef = useRef<Map<string, UserAudioPlayer>>(new Map());
  const ensureAudioPlayer = useCallback((sessionId: string) => {
    let player = audioPlayersRef.current.get(sessionId);
    if (!player) {
      player = new UserAudioPlayer();
      // 係員自身のマイクが入っている最中にONにされた場合は、最初から鳴らさない
      player.setMuted(micOnRef.current);
      audioPlayersRef.current.set(sessionId, player);
    }
    return player;
  }, []);
  const disposeAudioPlayer = useCallback((sessionId: string) => {
    audioPlayersRef.current.get(sessionId)?.dispose();
    audioPlayersRef.current.delete(sessionId);
  }, []);
  /** 画面を離れるときや再接続のときに、鳴っているものを全部止める。 */
  const disposeAllAudioPlayers = useCallback(() => {
    audioPlayersRef.current.forEach((player) => player.dispose());
    audioPlayersRef.current.clear();
  }, []);

  // ── Speech Recognition ───────────────────────────────────────────────────
  const { start: startMic, stop: stopMic, listening, error: micError, errorDetail: micErrorDetail, manualStop } = useSpeechRecognition({
    lang: "ja-JP",
    getSocket: () => socketRef.current,
    // Edge/streaming: 無音でOFFしたとき onFinal は発火しない → onStop で必ずセッションをクリア
    // （streaming では停止の数秒後に呼ばれる。その間に次のマイクONが始まっていたら消さない）
    onStop: () => {
      if (!micOnRef.current) activeListeningSession.current = null;
      // 確定テキスト待ちが明けた。何も話していなければ、ここで「準備しています」を解除する
      // （話していた場合は返答が届いた時点でキオスク側が消す）。
      if (!micOnRef.current && !typingSidRef.current) setComposingRef.current(null);
    },
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

      // 先に自分の発話を表示し、その id を clientId として送る。訳文が返ってきたら
      // この id の吹き出しに書き足す（同じ文言を続けて話しても取り違えない）。
      const entryId = makeId();
      setActiveSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(sid);
        if (session) {
          next.set(sid, {
            ...session,
            interimStaffText: "",
            transcript: [
              ...session.transcript,
              { id: entryId, speaker: "staff", text, isFinal: true, timestamp: Date.now() },
            ],
          });
        }
        return next;
      });

      socketRef.current?.emit("speech:staff", { sessionId: sid, text, isFinal: true, clientId: entryId });
      // ここから先の「準備しています」はサーバーが引き継ぐ（返答が届いた時点でキオスクが消す）。
      // 手元の記録だけ白紙に戻し、次の発話でまた案内を出せるようにする（通知は送らない）。
      // 消すときの宛先（lastComposingSidRef）はここでは消さない。
      composingSidRef.current = null;

      // 非ストリーミング（Chrome/Edge）は従来通りターン制: 送信後マイクOFF、再度押して話す。
      // ストリーミング時はマイクを止めず連続入力にする（キオスク側と同じ扱い）。
      if (!STREAMING) {
        stopMic();
        activeListeningSession.current = null;
        setActiveListeningId(null);
        micOnRef.current = false;
      }
    },
  });

  // 自分のマイク異常をサーバーへ知らせる（障害履歴に残すため）。画面の警告だけでは
  // その場限りで、後から「あの日この係員のマイクが不調だった」を追えないため。
  // お客様側（user:micError）と同じ扱い。null は解消の合図。
  useEffect(() => {
    socketRef.current?.emit("staff:micError", { code: micError });
  }, [micError]);

  // ── Screen Capture ───────────────────────────────────────────────────────
  const captureSessionRef = useRef<string | null>(null);

  const { startCapture, stopCapture, capturing } = useScreenCapture({
    fps: 5,
    quality: 0.6,
    // お客様画面（1920×1080）では共有画面を横1024ドットで映すため、送る絵も
    // それ以上にしておく。640×360のままだと引き伸ばしになり文字がぼやける。
    width: 1280,
    height: 720,
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
  /** 一度でも接続したことがあるか（connect イベントが「再接続」かどうかの判定に使う）。 */
  const hadConnectedRef = useRef(false);
  // 通話中のセッションの控え。再接続時の掃除（下の connect）と、スペースキーの
  // ショートカット（下方）から、描画中の状態に触れずに最新の中身を読むために使う。
  const activeSessionsRef = useRef(activeSessions);
  useEffect(() => { activeSessionsRef.current = activeSessions; }, [activeSessions]);
  useEffect(() => {
    const s = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = s;

    s.on("connect", () => {
      /**
       * ★再接続（初回以外の connect）のときは、画面に残っている通話パネルを全部消す。
       *
       * 2026-08-14 の基本性能テスト（日本語S6）で、通信の瞬断のたびに古い通話パネルが
       * 画面に残り、お客様の再呼び出しと合わせて「同じお客様で2画面」になった。
       * 接続が切れた時点でサーバーは古い接続の通話を終了扱いにしており、繋ぎ直した
       * この画面から古いパネルの通話を続ける手段は無い（マイクも文字も届かない）。
       * つまり再接続後に残っているパネルは全て幽霊。掃除してから staff:join し直す。
       * 応答前の着信は staff:join のときにサーバーが送り直してくれるので消してよい。
       */
      if (hadConnectedRef.current) {
        const hadPanels = activeSessionsRef.current.size > 0;
        // 鳴っているお客様の声も止める。パネルと同じで、繋ぎ直した後のこれらは
        // すべて古い通話のもの（サーバー側では既に終了扱い）。
        disposeAllAudioPlayers();
        setActiveSessions(new Map());
        setCallQueue([]);
        setPreviewFaceFrames(new Map());
        if (activeListeningSession.current) {
          stopMic();
          activeListeningSession.current = null;
          setActiveListeningId(null);
          micOnRef.current = false;
        }
        if (hadPanels) {
          addToast("通信が切れたため、進行中の通話は終了しました。お客様には再度の呼び出しが案内されています。", "warning");
        }
      }
      hadConnectedRef.current = true;
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
      disposeAudioPlayer(sessionId);
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

    // 通話ログの保存に失敗した。放置すると性能テストの記録が黙って欠ける。
    s.on("error:logSave", (payload: { sessionId: string }) => {
      addToast(`通話ログの保存に失敗しました（セッション ${payload.sessionId}）。管理者へご連絡ください。`, "error");
    });

    // S1: user's connection dropped unexpectedly
    s.on("call:userDisconnected", (payload: { sessionId: string; machineName: string; reason?: string }) => {
      // same-machine＝同じ端末IDから新しい呼び出しが来たので前の通話を終わらせた場合。
      // お客様が切ったわけではないので、そのままの文言だと原因を追えない。
      addToast(
        payload.reason === "same-machine"
          ? `${payload.machineName}と同じ端末から新しい呼び出しがあったため、前の通話を終了しました（1台の端末で同時に持てる通話は1件です）`
          : `${payload.machineName}のユーザーとの接続が切れました`,
        "error",
      );
    });

    // 未応答タイムアウト: 誰も応答しないまま呼び出しが打ち切られた。着信カードは
    // call:taken で消えるため、ここでは「取り逃した」ことだけ知らせる。
    s.on("call:missed", (payload: { sessionId: string; machineName: string; timeoutSeconds: number }) => {
      addToast(`${payload.machineName}の呼び出しに応答できないまま終了しました（${payload.timeoutSeconds}秒経過）`, "error");
    });

    // 音声合成に失敗した。係員の画面には自分の発言が普通に出るため、知らせないと
    // 「伝わった」と思ったまま進んでしまう。お客様側には文字だけ出している。
    s.on("error:tts", (payload: { sessionId: string; partial: boolean; reason?: string }) => {
      if (payload.reason === "playback") {
        // 返信を送った後に届くので、直近の自分の発言に印をつける。
        setActiveSessions((prev) => {
          const next = new Map(prev);
          const sess = next.get(payload.sessionId);
          if (!sess) return prev;
          const idx = [...sess.transcript].map((e) => e.speaker).lastIndexOf("staff");
          if (idx < 0) return prev;
          const transcript = sess.transcript.map((e, i) => (i === idx ? { ...e, voiceFailed: true } : e));
          next.set(payload.sessionId, { ...sess, transcript });
          return next;
        });
      }
      const msg = payload.reason === "playback"
        ? "お客様の端末で音声を再生できませんでした。お客様の画面には文字で表示しています。"
        : payload.partial
        ? "音声を最後まで届けられませんでした（途中が抜けています）。お客様の画面には文字で表示しました。短く区切って言い直してください。"
        : "音声をお届けできませんでした。お客様の画面には文字で表示しました。短く区切って言い直してください。";
      addToast(msg, "error");
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
      // 「呼び出し→着信表示」の計測。**着信カードが実際に画面に描かれてから**
      // サーバーへ合図を返す（サーバーは呼び出しを受けた時刻との差を記録する）。
      // 起点も終点もサーバー側の時計で取るので、端末どうしの時計のずれの影響を受けない。
      // requestAnimationFrame を2回重ねるのは、1回目が「描く直前」、2回目が
      // 「描いたあと」に呼ばれるため（＝表示が終わった時点を捉える）。
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          s.emit("call:incomingShown", { sessionId: payload.sessionId });
        });
      });
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
      disposeAudioPlayer(sessionId);
      setActiveSessions((prev) => {
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
      setCallQueue((prev) => prev.filter((c) => c.sessionId !== sessionId));
      // 「対応中（灰色）」の印も片付ける。終わった通話の印を残すと画面を開いている間
      // たまり続けるだけなので、カードと一緒に掃除する。
      setTakenSessions((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Set(prev);
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
    });

    // お客様が話しているか（音量で判定。マイクのON/OFF状態には依存しない）
    s.on("user:speaking", (payload: { sessionId: string; speaking: boolean }) => {
      updateSession(payload.sessionId, { userSpeaking: !!payload.speaking });
    });

    // お客様が通話中に言語を選び直したら、係員画面の言語表示（相手の言語ラベル・
    // 訳文の見出し）も追従させる。
    s.on("session:langChanged", (payload: { sessionId: string; lang: LangCode }) => {
      updateSession(payload.sessionId, { userLang: payload.lang });
    });

    // お客様画面のテキスト表示ON/OFF。お客様側・係員側のどちらが押しても、
    // サーバーが決めた状態がここへ届く（後から操作したほうが勝つ）。
    s.on("session:textVisible", (payload: { sessionId: string; visible: boolean }) => {
      updateSession(payload.sessionId, { textVisible: !!payload.visible });
    });

    // お客様側のマイク異常。係員からは「話さないお客様」にしか見えないため知らせる。
    s.on("user:micError", (payload: { sessionId: string; code: MicErrorCode | null }) => {
      updateSession(payload.sessionId, { userMicError: payload.code });
      if (payload.code) addToast(USER_MIC_ERR_JA[payload.code], "error");
    });

    // お客様マイクの状態（稼働中/一時停止/OFF）。通話パネルの表示と入/切ボタンに使う。
    s.on("user:micState", (payload: { sessionId: string; state: "on" | "paused" | "off" }) => {
      updateSession(payload.sessionId, { userMicState: payload.state });
    });

    // お客様の生の声。「お客様の声」をONにした通話の分だけ届く（既定はOFF）。
    s.on("user:audio", (payload: { sessionId: string; chunk: ArrayBuffer }) => {
      audioPlayersRef.current.get(payload.sessionId)?.push(payload.chunk);
    });

    // 「お客様の声」の入/切をサーバーが確定した合図。押した見た目と実際に届いて
    // いるかを食い違わせないよう、表示はこの返事に合わせる。
    s.on("user:audioState", (payload: { sessionId: string; on: boolean }) => {
      updateSession(payload.sessionId, { listenUserAudio: payload.on });
      if (!payload.on) disposeAudioPlayer(payload.sessionId);
    });

    // 自分（係員）の発話の訳文が返ってきたら、先に表示した吹き出しに書き足す。
    // 送った日本語と、お客様に届いた外国語の両方を係員が確認できるようにするため。
    s.on(
      "speech:staff",
      (payload: { sessionId: string; isFinal: boolean; clientId?: string; translatedText?: string; translationFailed?: boolean; voiceFailed?: boolean }) => {
        const { sessionId, isFinal, clientId, translatedText, translationFailed, voiceFailed } = payload;
        if (!isFinal || !clientId) return;
        setActiveSessions((prev) => {
          const next = new Map(prev);
          const session = next.get(sessionId);
          if (!session) return prev;
          next.set(sessionId, {
            ...session,
            transcript: session.transcript.map((e) =>
              e.id === clientId
                ? { ...e, ...(translatedText ? { translatedText } : {}), translationFailed, voiceFailed }
                : e),
          });
          return next;
        });
      }
    );

    s.on(
      "speech:user",
      (payload: { sessionId: string; text: string; lang: LangCode; isFinal: boolean; translatedText?: string; translationFailed?: boolean }) => {
        const { sessionId, text, translatedText, isFinal, translationFailed } = payload;
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
                { id: makeId(), speaker: "user", text, translatedText, isFinal: true, timestamp: Date.now(), translationFailed },
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
      // 映像が届いた＝カメラは生きている。到着時刻を持ち（途絶の判定に使う）、
      // 出ていた異常表示は消す。
      updateSession(payload.sessionId, {
        userCameraFaceFrame: payload.frameData,
        userCameraFaceFrameAt: Date.now(),
        userCameraError: null,
      });
    });

    // お客様側のカメラ異常（取得失敗の種類つき・C-1）。「映像なし」の枠に理由を出す。
    s.on("camera:error", (payload: { sessionId: string; code: string }) => {
      const CAM_ERR_JA: Record<string, string> = {
        "denied": "お客様の端末でカメラの使用が許可されていません",
        "in-use": "お客様の端末で他のアプリがカメラを使用中です",
        "not-found": "お客様の端末にカメラが見つかりません",
        "gone": "お客様の端末のカメラが外れました",
        "error": "お客様の端末でカメラを取得できませんでした",
      };
      updateSession(payload.sessionId, { userCameraError: CAM_ERR_JA[payload.code] ?? CAM_ERR_JA["error"] });
    });

    return () => { s.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 画面のプログラムエラーをサーバーの障害履歴へ申告する（提案②）
  useEffect(() => {
    return installClientErrorReporter(() => socketRef.current, "staff");
  }, []);

  /**
   * お客様音声をONにする。応答時の自動ON（既定ON・2026-08-17 ユーザー決定）と、
   * ボタンでの再ONの両方から呼ばれる。**クリック操作の中で呼ぶこと**＝ブラウザの
   * 音の許可（AudioContext の resume）は画面操作の中でしか取れない。
   * 応答ボタンのクリックがその操作を兼ねる。
   */
  const startListenUser = useCallback((sessionId: string) => {
    const turnOff = () => {
      socketRef.current?.emit("staff:listenUser", { sessionId, on: false });
      disposeAudioPlayer(sessionId);
      updateSession(sessionId, { listenUserAudio: false });
    };
    const ctx = getSharedAudioContext();
    if (!ctx) {
      addToast("このブラウザでは音声を再生できません。文字起こしでご確認ください。", "error");
      updateSession(sessionId, { listenUserAudio: false });
      return;
    }
    const player = ensureAudioPlayer(sessionId);
    socketRef.current?.emit("staff:listenUser", { sessionId, on: true });
    updateSession(sessionId, { listenUserAudio: true }); // 押した手応えのため先に反映
    const cannotPlay = () => {
      addToast(
        "この画面で音を鳴らせませんでした。タブがミュートになっていないか、音声の出力先と音量をご確認ください。",
        "error",
      );
      turnOff();
    };
    void ctx.resume().catch(() => { /* 下の確認で拾う */ }).then(() => {
      if (ctx.state !== "running") { cannotPlay(); return; }
      // ★押した直後は running と報告されても音が出ないことがある（検証で実際に遭遇）。
      //   少し待って「届いているのに1つも鳴らせていない」なら、結果を見て知らせる。
      setTimeout(() => {
        // すでにやめている／通話が終わっている場合は何もしない（余計な警告を出さない）
        if (audioPlayersRef.current.get(sessionId) !== player) return;
        if (player.blocked) cannotPlay();
      }, 3000);
    });
  }, [updateSession, addToast, ensureAudioPlayer, disposeAudioPlayer]);


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
      userCameraFaceFrameAt: previewFaceFrames.has(call.sessionId) ? Date.now() : null,
      userCameraError: null,
      isListening: false,
      isCapturing: false,
      userSpeaking: false,
      textVisible: false, // 既定は非表示。サーバー側の初期値と合わせる
      userMicError: null,
      // 応答直後にキオスクが自動ONにして最新状態を送ってくるまでの仮の値
      userMicState: "off",
      // お客様音声は既定ON（2026-08-17 ユーザー決定）。直後の startListenUser が
      // サーバーへONを伝える。鳴らせない端末では従来どおり警告してOFFに戻る。
      listenUserAudio: true,
    }]]));
    startListenUser(call.sessionId);
  }, [previewFaceFrames, startListenUser]);

  const rejectCall = useCallback((sessionId: string) => {
    socketRef.current?.emit("call:reject", { sessionId });
    setCallQueue((prev) => prev.filter((c) => c.sessionId !== sessionId));
    setTakenSessions((prev) => new Set([...prev, sessionId]));
  }, []);

  const endSession = useCallback((sessionId: string) => {
    socketRef.current?.emit("call:end", { sessionId });
    disposeAudioPlayer(sessionId);
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
  }, [stopMic, stopCapture, disposeAudioPlayer]);

  const toggleMic = useCallback((sessionId: string) => {
    // ★ON/OFFの判定は「今マイクが入っているか」(micOnRef)で行う。
    //   activeListeningSession は**遅れて届く確定テキストの行き先**でもあり、OFFにしても
    //   3秒間（フックのドレイン待ち）は消えない。これを判定に使うと、OFF直後の3秒間は
    //   「まだこの通話が持ち主だ」→「OFFにする分岐」と誤解し、**押しても何も起きない**。
    //   実機で「ONにするには2〜3回クリックが必要／OFFは1回」と報告された不具合の原因
    //   （Space は micOnRef で判定していたため影響を受けず、これが切り分けの決め手になった）。
    const isOnForThisSession = micOnRef.current && activeListeningSession.current === sessionId;
    if (isOnForThisSession) {
      // Turn off
      stopMic();
      // Chrome(Web Speech API): onFinal は同期的に発火済みか発火しない → 即座にクリア
      // Edge(Google STT)・streaming: onFinal / onStop が後から発火するのでそちらでクリアする
      // （遅れて届く確定テキストの行き先として残す必要があるため、ここでは消さない）
      if (!manualStop) activeListeningSession.current = null;
      setActiveListeningId(null);
      micOnRef.current = false;
    } else {
      // 別の通話でマイクが入っていれば先に止める（入っていないなら何もしない）
      if (micOnRef.current) {
        stopMic();
      }
      // Turn on this session
      activeListeningSession.current = sessionId;
      setActiveListeningId(sessionId);  // ▶ Fix: update state so UI re-renders
      micOnRef.current = true;
      startMic("ja-JP");
    }
  }, [stopMic, startMic, manualStop]);

  // ── 「係員が回答を準備しています」通知 ────────────────────────────────────────
  // お客様は話し終えた後、係員が回答を用意している間ずっと無反応の画面を見ることになり
  // 「伝わったのか」不安になる。マイクON中／入力中であることをキオスクに知らせる。
  const composingSidRef = useRef<string | null>(null); // 現在「準備中」を通知している通話
  /**
   * 直近で「準備中」を出した通話。**消すときの宛先**として使う。
   *
   * ★`composingSidRef` は発話の確定時に「手元の記録だけ」白紙に戻している（以降は
   * サーバーが引き継ぐため）。ところがサーバーは係員の声を検知するたびに出し直すので、
   * 手元の記録を信じると「もう消えているはず」と判断して**消す通知を送れない**。
   * 実際に「マイクをOFFにしてもお客様画面の『回答を準備しています』が消えない」が
   * 起きた（2026-08-17 ユーザー報告）。宛先だけは別に覚えておく。
   */
  const lastComposingSidRef = useRef<string | null>(null);
  const typingSidRef = useRef<string | null>(null);    // 入力欄に文字がある通話
  const setComposing = useCallback((sessionId: string | null) => {
    const prev = composingSidRef.current;
    if (sessionId === null) {
      // 消すときは、手元の記録に関わらず必ず送る（上記の理由）。
      const target = prev ?? lastComposingSidRef.current;
      if (target) socketRef.current?.emit("staff:composing", { sessionId: target, active: false });
      composingSidRef.current = null;
      lastComposingSidRef.current = null;
      return;
    }
    if (prev === sessionId) return; // 同じ状態の連投を避ける
    if (prev) socketRef.current?.emit("staff:composing", { sessionId: prev, active: false });
    socketRef.current?.emit("staff:composing", { sessionId, active: true });
    composingSidRef.current = sessionId;
    lastComposingSidRef.current = sessionId;
  }, []);
  // マイクONで通知する。OFFでは解除しない：切った後も確定テキスト待ち→翻訳→音声合成が
  // 続き、その間にお客様の画面が無反応になるため。解除はフックの onStop（確定待ちが明けた
  // とき）と、返答がお客様に届いた時点（キオスク側で判定）に任せる。
  useEffect(() => {
    if (listening && activeListeningId) setComposing(activeListeningId);
  }, [listening, activeListeningId, setComposing]);
  const setComposingRef = useRef(setComposing);
  useEffect(() => { setComposingRef.current = setComposing; }, [setComposing]);
  // お客様画面のテキスト表示を係員側から切り替える。お客様側の操作と対等で、
  // 後から操作したほうが勝つ（最終的な状態はサーバーからの通知で上書きされる）。
  const toggleTextVisible = useCallback((sessionId: string) => {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    const visible = !session.textVisible;
    socketRef.current?.emit("session:setTextVisible", { sessionId, visible });
    updateSession(sessionId, { textVisible: visible }); // 押した手応えのため先に反映
  }, [activeSessions, updateSession]);

  /**
   * 「お客様の声」を聞く／やめる（v1.42.0）。
   *
   * ★ONにするときは、このクリックの中で音の出口（AudioContext）を起こす必要がある。
   *   ブラウザは画面を触るまで音を鳴らさないため。しかも `resume()` は例外を投げずに
   *   止まったまま返ることがある（v1.34.1 でお客様側に同じ穴があった）。起きたことを
   *   確かめて、鳴らせないときは係員に理由を知らせてONを取り消す。
   */
  const toggleListenUser = useCallback((sessionId: string) => {
    const session = activeSessions.get(sessionId);
    if (!session) return;
    if (session.listenUserAudio) {
      socketRef.current?.emit("staff:listenUser", { sessionId, on: false });
      disposeAudioPlayer(sessionId);
      updateSession(sessionId, { listenUserAudio: false });
      return;
    }
    startListenUser(sessionId);
  }, [activeSessions, updateSession, disposeAudioPlayer, startListenUser]);

  /**
   * ★声の回り込み防止：係員自身のマイクが入っている間はお客様の声を鳴らさない。
   *
   * スピーカーから出たお客様の声を係員のマイクが拾うと、それが認識・翻訳されて
   * お客様へ返ってしまう。マイクを切れば即座に元どおり聞こえる（0.25秒ほど
   * 貯め直すだけ）。イヤホンを使う運用でも、この止め方が邪魔になることはない。
   *
   * `listening`（実際に聞き取りが始まった）だけでなく `activeListeningId`（押した直後）も
   * 見るのは、**押してから聞き取りが始まるまでの間に音を出さない**ため。
   *
   * ★ただしマイクが起動に失敗した場合（許可されていない・機器が無い等）は数に入れない。
   * `activeListeningId` は失敗しても立ったままになるので、これを外さないと
   * 「マイクは動いていないのにお客様音声だけ止まったまま」になり、次にマイクボタンを
   * 押し直すまで戻らない（2026-08-17 の検証で実際に発生）。
   */
  const staffMicOn = listening || (activeListeningId !== null && !micError);
  useEffect(() => {
    audioPlayersRef.current.forEach((player) => player.setMuted(staffMicOn));
  }, [staffMicOn]);

  // 画面を離れるときに鳴っているものを止める（AudioContext に音源が残らないように）
  useEffect(() => () => { disposeAllAudioPlayers(); }, [disposeAllAudioPlayers]);

  const justSentRef = useRef(false); // 直前の入力欄クリアが「送信」によるものか
  const handleTypingChange = useCallback((sessionId: string, typing: boolean) => {
    typingSidRef.current = typing ? sessionId : null;
    if (typing) { setComposing(sessionId); return; }
    // 送信でクリアされた場合は解除しない。ここで消すと、返答が届くまでの約1秒間、
    // お客様の画面が無反応になる（解除は返答が届いた時点でキオスク側が行う）。
    if (justSentRef.current) { justSentRef.current = false; return; }
    if (!micOnRef.current) setComposing(null);
  }, [setComposing]);

  // Space key shortcut: toggle mic (not when typing in input)
  // Uses refs so the handler is always registered once and reads latest values.
  const startMicRef = useRef(startMic);
  useEffect(() => { startMicRef.current = startMic; }, [startMic]);
  const stopMicRef = useRef(stopMic);
  useEffect(() => { stopMicRef.current = stopMic; }, [stopMic]);
  const capturingRef = useRef(capturing);
  useEffect(() => { capturingRef.current = capturing; }, [capturing]);
  const pttActiveRef = useRef(false); // Space プッシュ・トゥ・トークがマイクを開始したか

  // Space を受け付けない状況。この間はマイクボタンだけで操作する。
  //  ・2件同時通話: Space は「先に応答した通話」にしか向かわず、2件目には向けられない
  //  ・画面共有中: 共有先のウィンドウを触るとキー入力がそちらへ行き、Space が届かない
  // どちらも「効いたり効かなかったり」に見えて紛らわしいので、操作方法を1つに絞る。
  const spaceDisabled = activeSessions.size >= 2 || capturing;

  // Space = プッシュ・トゥ・トーク：押している間だけマイクON、離すとOFF。
  // マイクボタンは従来通りクリックでON/OFFトグル（toggleMic）。両者は独立して動く。
  useEffect(() => {
    const inField = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
    const targetSid = () =>
      activeListeningSession.current || Array.from(activeSessionsRef.current.keys())[0];
    const stopPtt = () => {
      if (!pttActiveRef.current) return;
      pttActiveRef.current = false;
      stopMicRef.current();
      micOnRef.current = false;
      // activeListeningSession はここでは消さない：停止直後に遅れて届く確定テキストの
      // 行き先として必要（フックが数秒のドレイン後 onStop で消す）。
      setActiveListeningId(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || inField(e.target)) return;
      e.preventDefault();
      // 2件同時通話中・画面共有中は Space では操作しない（マイクボタンだけを使う）。
      // preventDefault は先に済ませてあるので、ここで抜ければ Space は完全に無反応になる
      // （フォーカス中のボタンが Space で押される、画面がスクロールする、も起きない）。
      // キーを離す側（handleKeyUp）は塞がない：押している最中に2件目に応答した場合でも
      // 確実にマイクを止めるため。
      if (activeSessionsRef.current.size >= 2 || capturingRef.current) return;
      // ボタンにフォーカスが残っていると、Space がそのボタンの「クリック」として扱われ、
      // マイクボタンが勝手に押される（→ Spaceが効かなくなる）。フォーカスを外して防ぐ。
      if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === "BUTTON") {
        document.activeElement.blur();
      }
      if (e.repeat) return;         // 押しっぱなしの自動リピートは無視
      if (micOnRef.current) return; // 既にON（マイクボタン等）→ Spaceは干渉しない
      const sid = targetSid();
      if (!sid) return;
      pttActiveRef.current = true;  // このマイクONはSpace起因
      activeListeningSession.current = sid;
      setActiveListeningId(sid);
      micOnRef.current = true;
      startMicRef.current("ja-JP");
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || inField(e.target)) return;
      e.preventDefault(); // フォーカス中ボタンの Space クリック発火（keyup時）も抑止
      stopPtt();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", stopPtt); // フォーカスが外れたら確実にOFF
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", stopPtt);
    };
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
              <p className="text-xs text-gray-400">
                Remote Customer Service Console
                {/* 実行中の版。不具合報告のとき「どの版か」を読み上げてもらう（提案①） */}
                <span className="ml-1.5 text-gray-300">{APP_VERSION}</span>
              </p>
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
                        onClick={() => { setShowMicTest(true); setShowSettings(false); setShowPwForm(false); setShowQuickReplies(false); setShowAccountMenu(false); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <Mic size={15} className="text-gray-400" /> マイクテスト
                      </button>
                      <button
                        onClick={() => { setQrDraft(quickReplies); setQrSaved(false); setShowQuickReplies(true); setShowSettings(false); setShowPwForm(false); setShowMicTest(false); setShowAccountMenu(false); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <MessageSquare size={15} className="text-gray-400" /> 定型文設定
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
                      <a
                        href="/api/measure?test=1"
                        onClick={() => setShowAccountMenu(false)}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                        title="性能検証テスト用：名前が test- で始まる通話（テスト分）だけの遅延測定をCSVで保存します"
                      >
                        <Download size={15} className="text-gray-400" /> 測定CSVをダウンロード
                      </a>
                      <button
                        onClick={() => { setShowSettings(true); setShowPwForm(false); setShowMicTest(false); setShowQuickReplies(false); setShowAccountMenu(false); }}
                        className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors text-left"
                      >
                        <MapPin size={15} className="text-gray-400" /> 担当駅設定
                      </button>
                      <button
                        onClick={() => { setShowPwForm(true); setShowSettings(false); setShowMicTest(false); setShowQuickReplies(false); setPwMsg(""); setNewPw(""); setShowAccountMenu(false); }}
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
                          <Link
                            href="/admin/errors"
                            onClick={() => setShowAccountMenu(false)}
                            className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                          >
                            <AlertTriangle size={15} className="text-gray-400" /> 障害履歴
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
            ⚠️ {MIC_ERR_JA[micError]}{micErrorDetail ? `（${micErrorDetail}）` : ""}
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

        {/* マイクテストパネル（接客前の音量チェック） */}
        {showMicTest && (
          <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-xs font-semibold text-green-700 mb-2">マイクテスト</p>
            {micTestErr ? (
              <p className="text-xs text-red-500 mb-2">
                ❌ マイクを使用できません（{micTestErr}）。ブラウザのマイク許可設定をご確認ください。
              </p>
            ) : (
              <>
                <p className="text-xs text-gray-500 mb-2">
                  マイクに向かって話してください。緑のバーが動けばマイクは正常です。
                </p>
                <div className="h-4 w-full bg-gray-200 rounded-full overflow-hidden mb-1">
                  <div
                    className={`h-full transition-[width] duration-75 ${micLevel > 8 ? "bg-green-500" : "bg-gray-300"}`}
                    style={{ width: `${micLevel}%` }}
                  />
                </div>
                <p className="text-[11px] text-gray-400 mb-2">
                  {micLevel > 8 ? "🎤 音を検出しています" : "…静かです（話すと動きます）"}
                </p>
              </>
            )}
            <button
              onClick={() => setShowMicTest(false)}
              className="px-3 py-1 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white"
            >
              閉じる
            </button>
          </div>
        )}

        {/* 定型文の登録・編集パネル */}
        {showQuickReplies && (
          <div className="mt-3 p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
            <p className="text-xs font-semibold text-indigo-700 mb-2">定型文の登録（よく使う文をボタンで送信）</p>
            <div className="space-y-1.5 mb-2 max-h-60 overflow-y-auto">
              {qrDraft.length === 0 ? (
                <p className="text-xs text-gray-400">まだ定型文がありません。「＋ 追加」で登録してください。</p>
              ) : (
                qrDraft.map((phrase, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={phrase}
                      onChange={(e) => { setQrDraft((prev) => prev.map((p, j) => (j === i ? e.target.value : p))); setQrSaved(false); }}
                      placeholder="例：定期券の払い戻しは窓口で承ります"
                      maxLength={200}
                      className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <button
                      onClick={() => { setQrDraft((prev) => prev.filter((_, j) => j !== i)); setQrSaved(false); }}
                      title="削除"
                      className="px-2 py-1 text-red-500 border border-red-200 rounded-lg text-sm leading-none hover:bg-red-50 shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2 items-center">
              <button
                onClick={() => { setQrDraft((prev) => [...prev, ""]); setQrSaved(false); }}
                disabled={qrDraft.length >= 30}
                className="px-3 py-1 text-indigo-600 border border-indigo-300 text-xs rounded-lg hover:bg-white disabled:opacity-50"
              >
                ＋ 追加
              </button>
              <div className="flex-1" />
              {qrSaved && <span className="text-xs text-green-600">✓ 保存しました</span>}
              <button
                onClick={saveQuickReplies}
                disabled={savingQr}
                className="px-3 py-1 bg-indigo-600 text-white text-xs rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {savingQr ? "保存中..." : "保存"}
              </button>
              <button
                onClick={() => setShowQuickReplies(false)}
                className="px-3 py-1 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white"
              >
                閉じる
              </button>
            </div>
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
                  userCameraFaceFrameAt={session.userCameraFaceFrameAt}
                  userCameraError={session.userCameraError}
                  isListening={isListening}
                  spaceShortcut={!spaceDisabled}
                  isCapturing={capturing && captureSessionRef.current === session.sessionId}
                  micError={micError ? MIC_ERR_JA[micError] : null}
                  quickReplies={quickReplies}
                  soloView={sessions.length === 1}
                  textVisible={session.textVisible}
                  userMicError={session.userMicError ? USER_MIC_ERR_JA[session.userMicError] : null}
                  userMicState={session.userMicState}
                  onSetUserMic={(on) => socketRef.current?.emit("staff:setUserMic", { sessionId: session.sessionId, on })}
                  listenUserAudio={session.listenUserAudio}
                  listenPaused={staffMicOn}
                  onToggleListenUser={() => toggleListenUser(session.sessionId)}
                  onToggleText={() => toggleTextVisible(session.sessionId)}
                  onToggleMic={() => toggleMic(session.sessionId)}
                  onToggleScreenShare={() => toggleScreenShare(session.sessionId)}
                  onEnd={() => endSession(session.sessionId)}
                  onTypingChange={(typing) => handleTypingChange(session.sessionId, typing)}
                  userSpeaking={session.userSpeaking}
                  onSendText={(text) => {
                    justSentRef.current = true; // 直後の入力欄クリアで案内を消さないため
                    // Text input fallback: send as speech:staff final
                    const entryId = makeId();
                    setActiveSessions((prev) => {
                      const next = new Map(prev);
                      const s = next.get(session.sessionId);
                      if (s) {
                        next.set(session.sessionId, {
                          ...s,
                          interimStaffText: "",
                          transcript: [
                            ...s.transcript,
                            { id: entryId, speaker: "staff", text, isFinal: true, timestamp: Date.now() },
                          ],
                        });
                      }
                      return next;
                    });
                    socketRef.current?.emit("speech:staff", { sessionId: session.sessionId, text, isFinal: true, clientId: entryId });
                    composingSidRef.current = null; // 以降はサーバーが案内を引き継ぐ（宛先は残す）
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
