"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { PhoneCall, PhoneOff, Mic, X, Check, MessageSquareText, MessageSquareOff } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { KioskHeader } from "@/components/KioskHeader";
import { ScreenShareView } from "@/components/ScreenShareView";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { unlockAudioContext } from "@/lib/audioUnlock";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import type { TranscriptEntry } from "@/lib/types";
import type { LangCode } from "@/lib/socketEvents";

type Phase = "lang-select" | "idle" | "calling" | "in-call" | "ended" | "rejected" | "no-staff" | "disconnected" | "staff-disconnected";

// Error messages per language (U1/U2/U3)
const ERR: Record<string, { noStaff: string; noStaffSub: string; disconnected: string; disconnectedSub: string; staffDisconnected: string; staffDisconnectedSub: string; serverDown: string }> = {
  ja: { noStaff: "係員が不在です", noStaffSub: "しばらく後にもう一度お試しください。", disconnected: "接続が切れました", disconnectedSub: "ネットワークを確認して、もう一度お試しください。", staffDisconnected: "係員との接続が切れました", staffDisconnectedSub: "もう一度お呼び出しください。", serverDown: "サーバーに接続できません。ネットワークをご確認ください。" },
  en: { noStaff: "No staff available", noStaffSub: "Please try again later.", disconnected: "Connection lost", disconnectedSub: "Please check your network and try again.", staffDisconnected: "Staff connection lost", staffDisconnectedSub: "Please call again.", serverDown: "Cannot connect to server. Please check your network." },
  zh: { noStaff: "暂无工作人员", noStaffSub: "请稍后再试。", disconnected: "连接中断", disconnectedSub: "请检查网络并重试。", staffDisconnected: "与工作人员的连接中断", staffDisconnectedSub: "请再次呼叫。", serverDown: "无法连接到服务器，请检查网络。" },
  "zh-TW": { noStaff: "暫無服務人員", noStaffSub: "請稍後再試。", disconnected: "連線中斷", disconnectedSub: "請檢查網路並重試。", staffDisconnected: "與服務人員的連線中斷", staffDisconnectedSub: "請再次呼叫。", serverDown: "無法連線到伺服器，請檢查網路。" },
  ko: { noStaff: "담당자 부재 중", noStaffSub: "잠시 후 다시 시도해 주세요.", disconnected: "연결이 끊어졌습니다", disconnectedSub: "네트워크를 확인하고 다시 시도하세요.", staffDisconnected: "담당자와의 연결이 끊어졌습니다", staffDisconnectedSub: "다시 호출해 주세요.", serverDown: "서버에 연결할 수 없습니다. 네트워크를 확인하세요." },
  fr: { noStaff: "Aucun agent disponible", noStaffSub: "Veuillez réessayer plus tard.", disconnected: "Connexion perdue", disconnectedSub: "Vérifiez votre réseau et réessayez.", staffDisconnected: "Connexion avec l'agent perdue", staffDisconnectedSub: "Veuillez rappeler.", serverDown: "Impossible de se connecter au serveur." },
  es: { noStaff: "Sin personal disponible", noStaffSub: "Por favor, inténtelo más tarde.", disconnected: "Conexión perdida", disconnectedSub: "Verifique su red e inténtelo de nuevo.", staffDisconnected: "Se perdió la conexión con el agente", staffDisconnectedSub: "Por favor, vuelva a llamar.", serverDown: "No se puede conectar al servidor." },
  th: { noStaff: "ไม่มีเจ้าหน้าที่", noStaffSub: "กรุณาลองใหม่ภายหลัง", disconnected: "การเชื่อมต่อขาดหาย", disconnectedSub: "กรุณาตรวจสอบเครือข่ายและลองใหม่", staffDisconnected: "การเชื่อมต่อกับเจ้าหน้าที่ขาดหาย", staffDisconnectedSub: "กรุณาโทรหาอีกครั้ง", serverDown: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้" },
};

// 通話中の画面に出す文言。お客様が選んだ言語で表示する（日本語は翻訳が入らないので
// 注釈も「文字起こし」だけにする）。訳文は日本語へ訳し戻して意味を確認済み。
const UI_TEXT: Record<string, {
  delivered: string; composing: string; heading: string; cancel: string; notice: string;
  micOn: string; micOff: string;
  // 通話中の言語変更まわり。langLocked はマイクON中に変更しようとしたときの説明、
  // confirmQ / confirmYes は「変更後の言語」で表示する確認ダイアログの文言。
  langChange: string; langPick: string; langLocked: string; confirmQ: string; confirmYes: string;
  // 会話のテキスト表示 ON/OFF。マイクと同じ「状態表示」に合わせ、外国語は英語表記。
  textOn: string; textOff: string;
}> = {
  ja: {
    delivered: "係員に伝わりました", composing: "係員が回答を準備しています",
    heading: "ご用件をお伺いします。", cancel: "キャンセル",
    notice: "実際の係員との会話を、AIによる「音声発話」「翻訳」「メッセージ表示」等を用いて行います。",
    micOn: "マイクON", micOff: "マイクOFF",
    langChange: "言語を変える", langPick: "言語をお選びください",
    langLocked: "マイクをOFFにすると言語を変えられます",
    confirmQ: "この言語に変更しますか？", confirmYes: "変更する",
    textOn: "メッセージ表示ON", textOff: "メッセージ表示OFF",
  },
  en: {
    delivered: "Delivered to staff", composing: "Staff is preparing a reply",
    heading: "How may we help you?", cancel: "Cancel",
    notice: "You are talking with a real staff member. AI provides the spoken voice, the translation and the on-screen messages.",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "Change language", langPick: "Please select your language",
    langLocked: "Turn the mic off to change the language",
    confirmQ: "Change to this language?", confirmYes: "Change",
    textOn: "Text ON", textOff: "Text OFF",
  },
  zh: {
    delivered: "已送达工作人员", composing: "工作人员正在准备回复",
    heading: "请问有什么可以帮您？", cancel: "Cancel",
    notice: "您正在与真人工作人员对话。语音播报、翻译、消息显示等由AI提供。",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "更改语言", langPick: "请选择语言",
    langLocked: "请先关闭麦克风再更改语言",
    confirmQ: "要更改为该语言吗？", confirmYes: "更改",
    textOn: "Text ON", textOff: "Text OFF",
  },
  "zh-TW": {
    delivered: "已送達服務人員", composing: "服務人員正在準備回覆",
    heading: "請問有什麼可以為您服務？", cancel: "Cancel",
    notice: "您正在與真人服務人員對話。語音播報、翻譯、訊息顯示等由AI提供。",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "變更語言", langPick: "請選擇語言",
    langLocked: "請先關閉麥克風再變更語言",
    confirmQ: "要變更為此語言嗎？", confirmYes: "變更",
    textOn: "Text ON", textOff: "Text OFF",
  },
  ko: {
    delivered: "담당자에게 전달되었습니다", composing: "담당자가 답변을 준비하고 있습니다",
    heading: "무엇을 도와드릴까요?", cancel: "Cancel",
    notice: "실제 담당자와 대화하고 있습니다. 음성 발화, 번역, 메시지 표시 등은 AI가 제공합니다.",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "언어 변경", langPick: "언어를 선택해 주세요",
    langLocked: "마이크를 끄면 언어를 변경할 수 있습니다",
    confirmQ: "이 언어로 변경하시겠습니까?", confirmYes: "변경",
    textOn: "Text ON", textOff: "Text OFF",
  },
  fr: {
    delivered: "Transmis à l'agent", composing: "L'agent prépare une réponse",
    heading: "Comment pouvons-nous vous aider ?", cancel: "Cancel",
    notice: "Vous parlez avec un agent réel. L'IA fournit la voix, la traduction et l'affichage des messages.",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "Changer de langue", langPick: "Veuillez choisir votre langue",
    langLocked: "Désactivez le micro pour changer de langue",
    confirmQ: "Changer pour cette langue ?", confirmYes: "Changer",
    textOn: "Text ON", textOff: "Text OFF",
  },
  es: {
    delivered: "Enviado al personal", composing: "El personal está preparando una respuesta",
    heading: "¿En qué podemos ayudarle?", cancel: "Cancel",
    notice: "Está hablando con un agente real. La IA proporciona la voz, la traducción y la visualización de mensajes.",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "Cambiar idioma", langPick: "Seleccione su idioma",
    langLocked: "Desactive el micrófono para cambiar de idioma",
    confirmQ: "¿Cambiar a este idioma?", confirmYes: "Cambiar",
    textOn: "Text ON", textOff: "Text OFF",
  },
  th: {
    delivered: "ส่งถึงเจ้าหน้าที่แล้ว", composing: "เจ้าหน้าที่กำลังเตรียมคำตอบ",
    heading: "มีอะไรให้เราช่วยเหลือไหม", cancel: "Cancel",
    notice: "คุณกำลังสนทนากับเจ้าหน้าที่จริง โดยใช้ AI ในการอ่านออกเสียง การแปล และการแสดงข้อความ",
    micOn: "Mic ON", micOff: "Mic OFF",
    langChange: "เปลี่ยนภาษา", langPick: "กรุณาเลือกภาษา",
    langLocked: "ปิดไมโครโฟนเพื่อเปลี่ยนภาษา",
    confirmQ: "ต้องการเปลี่ยนเป็นภาษานี้หรือไม่", confirmYes: "เปลี่ยน",
    textOn: "Text ON", textOff: "Text OFF",
  },
};

/** 係員から解除通知が届かない場合でも「準備しています」が残り続けないようにする保険。 */
const COMPOSING_MAX_MS = 60_000;
/** アバターが話し終えてから発話検知を再開するまでの余韻（スピーカーの残響・反響対策）。 */
const AVATAR_TAIL_MS = 500;

let entryCounter = 0;
function makeId() { return `e-${Date.now()}-${entryCounter++}`; }

// Streaming STT keeps the mic open for continuous speech; the legacy paths send
// one final per mic session and auto-OFF. Gated by the same env flag as the hook.
const STREAMING_STT = process.env.NEXT_PUBLIC_STT_MODE === "streaming";

// 通話中画面の背景：淡い水色のドット地 + 左端の縦帯
const DOT_BACKGROUND = {
  backgroundColor: "#e2f7fa",
  backgroundImage: "radial-gradient(circle, #a3dbe7 1.1px, transparent 1.3px)",
  backgroundSize: "6px 6px",
} as const;

const LEFT_STRIPE = {
  background: "linear-gradient(180deg, #12b5e5 0%, #7ad8f0 30%, #d3f1fb 70%, #e2f7fa 100%)",
} as const;

const CANCEL_BUTTON = {
  background: "linear-gradient(180deg, #e9dff6 0%, #c8b2e4 100%)",
} as const;

// マイクボタン。キャンセルと同じ「立体的な丸ボタン」の見た目にそろえたうえで、
// OFF は灰色、ON は桃色にして、いま録っているかどうかが色で分かるようにする。
const MIC_BUTTON_OFF = {
  background: "linear-gradient(180deg, #f6f7f9 0%, #d9dde3 100%)",
} as const;

const MIC_BUTTON_ON = {
  background: "linear-gradient(180deg, #fde7f0 0%, #f4a6c6 100%)",
} as const;

interface UserScreenProps {
  machineId: string;
  machineName: string;
  stationId?: string;
  line?: string;
  stationName?: string;
  stationCode?: string;
}

export function UserScreen({ machineId, machineName, stationId = "", line, stationName, stationCode }: UserScreenProps) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>("lang-select");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userLang, setUserLang] = useState<LangCode>("ja");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [interimUser, setInterimUser] = useState("");
  const [interimStaff, setInterimStaff] = useState("");

  // TTS state: the staff's speech is voiced only by Google TTS (base64 audio).
  // No browser Web-Speech fallback — that used a device voice (sometimes male),
  // which broke the consistent female station-attendant voice.
  const [latestAudio, setLatestAudio] = useState<string | undefined>(undefined);

  const [staffScreenFrame, setStaffScreenFrame] = useState<string | null>(null);
  // 通話中の言語変更。パネルを開いてから言語を選び、確認してはじめて切り替わる。
  const [langPanelOpen, setLangPanelOpen] = useState(false);
  const [pendingLang, setPendingLang] = useState<LangCode | null>(null);
  // 会話のテキストを画面に出すか。**既定は非表示**。お客様側・係員側のどちらからでも
  // 切り替えられ、状態はサーバーが持つ（後から操作したほうが勝つ）。
  const [textVisible, setTextVisible] = useState(false);
  const [showConnectWarning, setShowConnectWarning] = useState(false);
  const [deliveredIds, setDeliveredIds] = useState<string[]>([]); // 係員に届いた発言のid
  const [staffComposing, setStaffComposing] = useState(false);    // 係員が回答を準備中
  const connectWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const userLangRef = useRef<LangCode>("ja");
  const micOnRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  /** 発言を1件追加し、そのidを返す（お客様の発言は「係員に伝わりました」の照合に使う）。 */
  const addEntry = useCallback((entry: Omit<TranscriptEntry, "id" | "timestamp">) => {
    const id = makeId();
    setTranscript((prev) => [...prev, { ...entry, id, timestamp: Date.now() }]);
    return id;
  }, []);

  const langConfig = SUPPORTED_LANGS.find((l) => l.code === userLang);

  const { start: startMic, stop: stopMic, listening, error: micError } = useSpeechRecognition({
    lang: langConfig?.bcp47 ?? "ja-JP",
    getSocket: () => socketRef.current,
    onInterim: (text) => setInterimUser(text),
    onFinal: (text) => {
      // Reject if recognized text matches what the avatar just said (echo)
      const avatarText = lastAvatarTextRef.current;
      if (avatarText && text.replace(/\s/g, "") === avatarText.replace(/\s/g, "")) {
        setInterimUser("");
        return;
      }
      setInterimUser("");
      const clientId = addEntry({ speaker: "user", text, isFinal: true });
      socketRef.current?.emit("speech:user", {
        sessionId: sessionIdRef.current,
        text,
        lang: userLangRef.current,
        isFinal: true,
        clientId, // 係員に届いたら speech:delivered でこのidが返る
      });
      // Legacy paths give one final per mic session → auto-OFF after sending.
      // Streaming gives a final per pause, so keep the mic ON for continuous speech.
      if (!STREAMING_STT) {
        stopMic();
        micOnRef.current = false;
      }
    },
  });

  // Camera devices — the real kiosk hardware has 2 fixed cameras (face + hand).
  // For this demo, we auto-detect up to 2 connected cameras (built-in + external USB webcam).
  // Detection is deferred until the call actually starts (same timing as the original
  // single-camera permission prompt), not on page load, to avoid an unexpected
  // permission request/error on the language-select screen.
  const cameraDevicesRef = useRef<{ face?: string; hand?: string } | null>(null);

  const detectCameraDevices = useCallback(async () => {
    if (cameraDevicesRef.current) return cameraDevicesRef.current;
    try {
      // A camera permission grant is required before device labels/ids are enumerable
      const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tmp.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      // enumerateDevices() の並び順はブラウザ依存で、Chrome と Edge で逆になる（＝正面/手元が
      // 入れ替わる原因）。deviceId はブラウザごとにハッシュ化され使えないが、label は
      // ブラウザをまたいで同一（USBの vendor:product 等を含む）なので、label 昇順でソートして
      // どのブラウザでも同じ物理カメラが 1番目(正面)/2番目(手元) になるよう固定する。
      const cams = devices
        .filter((d) => d.kind === "videoinput")
        .sort((a, b) => a.label.localeCompare(b.label));
      // 設置の都合で正面/手元を入れ替えたい場合は、キオスクURLに ?swapcam=1 を付ける。
      const swap = new URLSearchParams(window.location.search).get("swapcam") === "1";
      const faceCam = swap ? cams[1] : cams[0];
      const handCam = swap ? cams[0] : cams[1];
      console.log(`[camera] 正面=${faceCam?.label ?? "なし"} / 手元=${handCam?.label ?? "なし"}${swap ? "（swapcam=1で入替）" : ""}`);
      cameraDevicesRef.current = { face: faceCam?.deviceId, hand: handCam?.deviceId };
    } catch (e) {
      console.error("[camera] device enumeration failed:", e);
      cameraDevicesRef.current = {};
    }
    return cameraDevicesRef.current;
  }, []);

  // Face camera (正面) — auto-starts when call connects, streams frames to staff via screen:frame
  const { startCapture: startFaceCamera, stopCapture: stopFaceCamera } = useScreenCapture({
    fps: 5,
    quality: 0.6,
    width: 320,
    height: 240,
    onFrame: (frameData) => {
      if (sessionIdRef.current) {
        socketRef.current?.emit("screen:frame", { sessionId: sessionIdRef.current, frameData, camera: "face" });
      }
    },
  });

  // Hand camera (手元) — only started if a second camera device was detected
  const { startCapture: startHandCamera, stopCapture: stopHandCamera } = useScreenCapture({
    fps: 5,
    quality: 0.6,
    width: 320,
    height: 240,
    onFrame: (frameData) => {
      if (sessionIdRef.current) {
        socketRef.current?.emit("screen:frame", { sessionId: sessionIdRef.current, frameData, camera: "hand" });
      }
    },
  });

  // Face camera starts as soon as the call starts ringing — lets staff see who's
  // calling on the incoming-call card before pressing 応答 (answer). Hand camera
  // only starts once the call is actually answered (in-call).
  const isRingingOrInCall = phase === "calling" || phase === "in-call";
  const isInCall = phase === "in-call";

  useEffect(() => {
    if (isRingingOrInCall) {
      detectCameraDevices().then((devices) => startFaceCamera("camera", devices.face));
    } else {
      stopFaceCamera();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRingingOrInCall]);

  useEffect(() => {
    if (isInCall) {
      detectCameraDevices().then((devices) => {
        if (devices.hand) startHandCamera("camera", devices.hand);
      });
    } else {
      stopHandCamera();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInCall]);

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

  // 通話中の言語変更を確定する。マイクOFF時しか呼ばれないので、認識中のストリームを
  // 張り替える必要はない（次にマイクをONにしたとき新しい言語で始まる）。翻訳とアバターの
  // 声はサーバーが毎回この言語を見るため、切り替えた直後から新しい言語になる。
  const confirmLangChange = useCallback(() => {
    if (!pendingLang) return;
    setUserLang(pendingLang);
    setPendingLang(null);
    setLangPanelOpen(false);
    const sid = sessionIdRef.current;
    if (sid) socketRef.current?.emit("session:setLang", { sessionId: sid, lang: pendingLang });
  }, [pendingLang]);

  const closeLangPanel = useCallback(() => {
    setLangPanelOpen(false);
    setPendingLang(null);
  }, []);

  // 会話のテキスト表示を切り替える。押した手応えのため画面には先に反映し、
  // 最終的な状態はサーバーから届く通知で上書きする（係員と同時に押した場合の整合）。
  const toggleTextVisible = useCallback(() => {
    const next = !textVisible;
    setTextVisible(next);
    const sid = sessionIdRef.current;
    if (sid) socketRef.current?.emit("session:setTextVisible", { sessionId: sid, visible: next });
  }, [textVisible]);

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

  // U1: show connection warning after 8s of no connection
  useEffect(() => {
    if (!connected) {
      connectWarningTimerRef.current = setTimeout(() => setShowConnectWarning(true), 8000);
    } else {
      if (connectWarningTimerRef.current) clearTimeout(connectWarningTimerRef.current);
      setShowConnectWarning(false);
    }
    return () => { if (connectWarningTimerRef.current) clearTimeout(connectWarningTimerRef.current); };
  }, [connected]);

  // U3: browser-native offline/online events fire instantly (Socket.IO can take up to 45s)
  useEffect(() => {
    const handleOffline = () => {
      setConnected(false);
      setPhase((prev) => (prev === "in-call" || prev === "calling") ? "disconnected" : prev);
    };
    const handleOnline = () => {
      const s = socketRef.current;
      if (!s) return;
      if (s.connected) {
        // Local env: socket was never actually disconnected (loopback unaffected by WiFi)
        // Just restore UI state
        setConnected(true);
        setPhase((prev) => prev === "disconnected" ? "idle" : prev);
        setTranscript([]);
        setSessionId(null);
        sessionIdRef.current = null;
        setStaffScreenFrame(null);
        setLatestAudio(undefined);
        setInterimStaff("");
      } else {
        // Production env: actually disconnected — force reconnect
        s.connect();
      }
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  // Clears all per-call state (transcript, session, staff frame/audio, mic).
  // Used whenever a call ends or the kiosk returns to a neutral screen, so the
  // next customer never inherits the previous conversation on a shared kiosk.
  const resetCallState = useCallback(() => {
    stopMic();
    micOnRef.current = false;
    setTranscript([]);
    setInterimUser("");
    setInterimStaff("");
    setSessionId(null);
    sessionIdRef.current = null;
    setStaffScreenFrame(null);
    setLatestAudio(undefined);
    setDeliveredIds([]);
    setStaffComposing(false);
    // テキスト表示は通話ごとに既定（非表示）へ戻す。前のお客様の設定を引き継がない。
    setTextVisible(false);
    setLangPanelOpen(false);
    setPendingLang(null);
  }, [stopMic]);

  // Socket.IO setup
  useEffect(() => {
    const s = io({ path: "/socket.io", transports: ["websocket", "polling"] });
    socketRef.current = s;
    s.on("connect", () => {
      setConnected(true);
      // On (re)connect the server has no session for this fresh socket, so any
      // ongoing call is gone. Wipe the previous conversation (safe/no-op when
      // idle) so the next customer on a shared kiosk never inherits it, then
      // return to idle if we were mid-call.
      resetCallState();
      setPhase((prev) => (prev === "in-call" || prev === "calling" || prev === "disconnected") ? "idle" : prev);
    });
    s.on("disconnect", () => {
      setConnected(false);
      // Show disconnect screen if currently in a call or waiting
      setPhase((prev) => (prev === "in-call" || prev === "calling") ? "disconnected" : prev);
    });

    s.on("call:requested", (payload: { sessionId: string }) => {
      // sessionId is known before any staff answers — lets the face camera
      // (already streaming while ringing) tag its frames correctly.
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
    });

    s.on("call:answered", (payload: { sessionId: string }) => {
      sessionIdRef.current = payload.sessionId;
      setSessionId(payload.sessionId);
      setPhase("in-call");
    });

    s.on("call:noStaff", () => {
      // U2: no responsive staff at all
      setPhase("no-staff");
      setTimeout(() => setPhase("idle"), 5000);
    });

    s.on("call:rejected", () => {
      // Staff declined — show message briefly then return to lang-select
      setPhase("rejected");
      setSessionId(null);
      sessionIdRef.current = null;
      setTimeout(() => setPhase("lang-select"), 3000);
    });

    s.on("call:staffDisconnected", () => {
      setPhase("staff-disconnected");
      stopMic();
      micOnRef.current = false;
      setTimeout(() => {
        setPhase("idle");
        resetCallState();
      }, 5000);
    });

    s.on("call:ended", () => {
      setPhase("ended");
      stopMic();
      micOnRef.current = false;
      // Return to lang-select after 3 seconds
      setTimeout(() => {
        setPhase("lang-select");
        resetCallState();
      }, 3000);
    });

    // お客様の発言が係員の画面に届いた（既読チェックを表示する）
    s.on("speech:delivered", (payload: { clientId: string }) => {
      if (payload.clientId) setDeliveredIds((prev) => [...prev, payload.clientId]);
    });

    // 係員がマイクON／入力中＝回答を準備している
    s.on("staff:composing", (payload: { active: boolean }) => {
      setStaffComposing(!!payload.active);
    });

    // テキスト表示の切り替え。お客様側・係員側のどちらが押しても、サーバーが決めた
    // 状態がここへ届く。後から操作したほうが必ず勝つ。
    s.on("session:textVisible", (payload: { visible: boolean }) => {
      setTextVisible(!!payload.visible);
    });

    s.on("speech:staff", (payload: { text: string; isFinal: boolean }) => {
      setStaffComposing(false); // 返事が来た（途中表示でも）＝準備中の表示は不要
      if (payload.isFinal) {
        setInterimStaff("");
        addEntry({ speaker: "staff", text: payload.text, isFinal: true });
        setLatestAudio(undefined);
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
  }, [transcript, interimStaff, staffComposing]);

  // 解除通知が届かなかった場合の保険（係員が入力途中で離席した等）。
  useEffect(() => {
    if (!staffComposing) return;
    const t = setTimeout(() => setStaffComposing(false), COMPOSING_MAX_MS);
    return () => clearTimeout(t);
  }, [staffComposing]);

  const selectLang = (code: LangCode) => {
    unlockAudioContext(); // running inside a tap → unlock audio for the staff's TTS
    setUserLang(code);
    setPhase("idle");
  };

  const callStaff = () => {
    if (!connected) return;
    unlockAudioContext(); // ensure audio is unlocked even if lang-select was skipped
    setPhase("calling");
    socketRef.current?.emit("call:request", { machineId, machineName, userLang, stationId });
  };

  const endCall = () => {
    socketRef.current?.emit("call:end", { sessionId });
  };

  // アバターの発話中はサーバーに知らせ、係員画面の「お客様発話中」の誤点灯を防ぐ
  // （キオスクのマイクはアバター自身の声も拾うため）。終了時は残響を拾わないよう
  // 少し余韻を置いてから解除する。
  const avatarTailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyAvatarSpeaking = useCallback((speaking: boolean) => {
    if (avatarTailRef.current) { clearTimeout(avatarTailRef.current); avatarTailRef.current = null; }
    const send = (v: boolean) =>
      socketRef.current?.emit("user:avatarSpeaking", { sessionId: sessionIdRef.current, speaking: v });
    if (speaking) { send(true); return; }
    avatarTailRef.current = setTimeout(() => { avatarTailRef.current = null; send(false); }, AVATAR_TAIL_MS);
  }, []);
  useEffect(() => () => { if (avatarTailRef.current) clearTimeout(avatarTailRef.current); }, []);

  const errMsg = ERR[userLang] ?? ERR.ja;
  const ui = UI_TEXT[userLang] ?? UI_TEXT.ja;
  // 言語変更の確認ダイアログは「変更後の言語」で出すため、その言語の設定と文言を先に引く。
  const pendingLangConfig = pendingLang ? SUPPORTED_LANGS.find((l) => l.code === pendingLang) : undefined;
  const pendingUi = pendingLang ? (UI_TEXT[pendingLang] ?? UI_TEXT.ja) : undefined;
  // テキスト非表示のとき、直前のお客様の発言が係員に届いたか（単独表示の判定に使う）。
  const lastEntry = transcript[transcript.length - 1];
  const lastEntryDelivered = lastEntry?.speaker === "user" && deliveredIds.includes(lastEntry.id);

  // --- No Staff ---
  if (phase === "no-staff") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-24 h-24 rounded-full bg-orange-500/20 flex items-center justify-center">
          <span className="text-5xl">🔔</span>
        </div>
        <p className="text-white text-2xl font-bold text-center">{errMsg.noStaff}</p>
        <p className="text-blue-300 text-base text-center">{errMsg.noStaffSub}</p>
      </div>
    );
  }

  // --- Disconnected ---
  if (phase === "disconnected") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-24 h-24 rounded-full bg-red-500/20 flex items-center justify-center">
          <span className="text-5xl">📡</span>
        </div>
        <p className="text-white text-2xl font-bold text-center">{errMsg.disconnected}</p>
        <p className="text-blue-300 text-base text-center">{errMsg.disconnectedSub}</p>
        <div className="flex items-center gap-2 text-blue-400 text-sm">
          <span className="inline-block w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
          再接続中...
        </div>
      </div>
    );
  }

  // --- Staff Disconnected ---
  if (phase === "staff-disconnected") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-24 h-24 rounded-full bg-orange-500/20 flex items-center justify-center">
          <span className="text-5xl">📡</span>
        </div>
        <p className="text-white text-2xl font-bold text-center">{errMsg.staffDisconnected}</p>
        <p className="text-blue-300 text-base text-center">{errMsg.staffDisconnectedSub}</p>
      </div>
    );
  }

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
        {/* U1: connection warning banner */}
        {showConnectWarning && (
          <div className="fixed top-0 left-0 right-0 bg-red-600 text-white text-center py-3 px-4 text-sm font-medium z-50">
            ⚠ {errMsg.serverDown}
          </div>
        )}
        <div className="text-center mb-8">
          <h1 className="text-xl font-bold text-white mb-1">{machineName}</h1>
          <p className="text-blue-300 text-sm flex items-center justify-center gap-2">
            {connected ? "接続中" : "接続待機中..."}
            <span className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-gray-400 animate-pulse"}`} />
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
    <div className="h-screen flex flex-col overflow-hidden relative" style={DOT_BACKGROUND}>
      {/* 左端の縦帯（ヘッダーより手前に重ねる） */}
      <div className="absolute left-0 top-0 bottom-0 w-2.5 z-20 pointer-events-none" style={LEFT_STRIPE} />

      <KioskHeader line={line} stationName={stationName} stationCode={stationCode} />

      {/* 見出し（下に全幅の区切り線） */}
      <div className="shrink-0 px-28 pt-8 pb-6 border-b border-[#7fd0e4]">
        <h1 className="text-[44px] leading-none font-bold text-gray-900">
          {ui.heading}
        </h1>
        {/* AIが自動で文字起こし（外国語では翻訳も）していることを明示する。 */}
        <p className="mt-3 text-lg text-gray-500">{ui.notice}</p>
      </div>

      <div className="flex-1 flex overflow-hidden">
      {/* LEFT: chat + controls */}
      <div className="flex flex-col w-[58%] px-28 pt-6 pb-8 overflow-hidden">
        {/* Chat bubbles。テキスト表示がOFFのときは会話の文字だけを出さない。
            「係員に伝わりました」「係員が回答を準備しています」は状況を伝える表示
            なので、音声をテキスト化したものではなく、OFFでも残す。 */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
          {textVisible &&
            transcript.map((entry) => (
              <div key={entry.id} className="max-w-[90%]">
                <div
                  className={`rounded-3xl px-7 py-4 text-2xl font-medium leading-snug shadow-sm ${
                    entry.speaker === "user"
                      ? "bg-amber-300 text-gray-900"
                      : "bg-sky-200 text-gray-900"
                  }`}
                >
                  {entry.text}
                </div>
                {/* 係員の画面に届いた合図。待っている間の「伝わったのか」という不安に応える。 */}
                {entry.speaker === "user" && deliveredIds.includes(entry.id) && (
                  <p className="mt-1.5 ml-2 flex items-center gap-1.5 text-lg text-gray-500">
                    <Check size={20} strokeWidth={3} className="text-emerald-600" />
                    {ui.delivered}
                  </p>
                )}
              </div>
            ))}

          {/* テキスト非表示のときは吹き出しがないので、「伝わりました」を単独で出す
              （直前の発言が届いたときだけ）。 */}
          {!textVisible && lastEntryDelivered && (
            <p className="flex items-center gap-1.5 text-lg text-gray-500">
              <Check size={20} strokeWidth={3} className="text-emerald-600" />
              {ui.delivered}
            </p>
          )}

          {textVisible && interimStaff && (
            <div className="rounded-3xl px-7 py-4 text-2xl text-gray-400 italic max-w-[90%] bg-sky-100 shadow-sm">
              {interimStaff}
            </div>
          )}

          {/* 係員がマイクON／入力中＝いま対応している、を伝える。 */}
          {staffComposing && !interimStaff && (
            <div className="flex items-center gap-3 rounded-3xl px-7 py-4 max-w-[90%] bg-sky-100 shadow-sm">
              <span className="flex gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2.5 h-2.5 rounded-full bg-sky-500 animate-bounce" />
              </span>
              <span className="text-2xl text-gray-600">{ui.composing}</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Bottom controls */}
        <div className="flex items-center gap-4 mt-6 shrink-0">
          <button
            onClick={endCall}
            style={CANCEL_BUTTON}
            className="flex items-center gap-4 py-2.5 pl-2.5 pr-9 active:scale-95 text-[#6b4c9a] rounded-full text-3xl font-bold shadow-lg ring-[6px] ring-white/80 transition-all shrink-0"
          >
            <span className="flex items-center justify-center w-14 h-14 rounded-full bg-[#8b5cf6] shrink-0">
              <X size={30} strokeWidth={3} className="text-white" />
            </span>
            {ui.cancel}
          </button>

          <button
            onClick={toggleMic}
            style={listening ? MIC_BUTTON_ON : MIC_BUTTON_OFF}
            className={`flex-1 flex items-center gap-4 py-2.5 pl-2.5 pr-9 active:scale-95 rounded-full shadow-lg ring-[6px] ring-white/80 transition-all text-left ${
              listening ? "text-[#a3306a]" : "text-gray-500"
            }`}
          >
            <div
              className={`w-14 h-14 rounded-full flex items-center justify-center shrink-0 relative transition-colors ${
                listening ? "bg-[#ec4899]" : "bg-gray-400"
              }`}
            >
              {listening && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pink-300 opacity-60" />
              )}
              <Mic size={30} strokeWidth={3} className="text-white relative z-10" />
            </div>
            <div className="flex-1 overflow-hidden">
              {listening ? (
                <p className="leading-snug line-clamp-2">
                  <span className="text-3xl font-bold">{ui.micOn}</span>
                  {/* 認識中の文字も「音声をテキスト化したもの」なので、非表示のときは出さない。 */}
                  {textVisible && interimUser && <span className="ml-3 text-xl text-gray-700">{interimUser}</span>}
                </p>
              ) : micError ? (
                <p className="text-base text-red-500">{micError}</p>
              ) : (
                <p className="text-3xl font-bold">{ui.micOff}</p>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* RIGHT: Screen share (when active) + Avatar */}
      <div className="w-[42%] flex flex-col">
        {staffScreenFrame && (
          <div className="p-4 pb-2 shrink-0">
            <ScreenShareView
              frameData={staffScreenFrame}
              label="スタッフ画面"
              className="h-52 w-full rounded-xl overflow-hidden border-2 border-sky-400"
            />
          </div>
        )}
        <div className="flex-1 min-h-0 flex items-end justify-center pb-2">
          <Avatar
            audioBase64={latestAudio}
            onSpeakingChange={notifyAvatarSpeaking}
            visible
            size="xl"
          />
        </div>

        {/* アバターの下の設定ボタン。左＝会話のテキスト表示ON/OFF、右＝言語の選び直し。
            言語のほうはマイクON中は認識中の音声を取りこぼすため変更させず、押されたら
            理由を説明する（無反応にすると壊れていると思われるため）。 */}
        <div className="shrink-0 flex justify-center items-center gap-4 pb-8">
          <button
            onClick={toggleTextVisible}
            className={`flex items-center gap-3 py-2 pl-2 pr-7 rounded-full shadow-lg ring-[6px] ring-white/80 active:scale-95 transition-all ${
              textVisible ? "bg-sky-100 hover:bg-sky-200" : "bg-white hover:bg-gray-50"
            }`}
          >
            <span
              className={`w-14 h-14 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                textVisible ? "bg-sky-500" : "bg-gray-400"
              }`}
            >
              {textVisible
                ? <MessageSquareText size={28} strokeWidth={2.5} className="text-white" />
                : <MessageSquareOff size={28} strokeWidth={2.5} className="text-white" />}
            </span>
            <span className={`text-2xl font-bold ${textVisible ? "text-sky-800" : "text-gray-500"}`}>
              {textVisible ? ui.textOn : ui.textOff}
            </span>
          </button>

          <button
            onClick={() => setLangPanelOpen(true)}
            className={`flex items-center gap-3 bg-white py-2 pl-2 pr-7 rounded-full shadow-lg ring-[6px] ring-white/80 active:scale-95 transition-all ${
              listening ? "opacity-50" : "hover:bg-gray-50"
            }`}
          >
            <span className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center shrink-0 text-4xl leading-none">
              {langConfig?.flag}
            </span>
            <span className="text-2xl text-gray-700 font-bold">{ui.langChange}</span>
          </button>
        </div>
      </div>
      </div>

      {/* 言語の選び直し（一覧 →「確認」→ 切替）。押し間違いをそのまま通さないため、
          必ず確認を1枚挟む。確認は「変更後の言語」で出しつつ、押し間違えても分かるよう
          「今の言語」でも併記する。 */}
      {langPanelOpen && (
        <div
          className="absolute inset-0 z-40 bg-black/40 flex items-center justify-center p-10"
          onClick={closeLangPanel}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl px-12 py-10 w-full max-w-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            {listening ? (
              // マイクON中は変更させない（認識中の音声を取りこぼすため）
              <>
                <p className="text-3xl font-bold text-gray-900 text-center leading-snug">{ui.langLocked}</p>
                <div className="mt-10 flex justify-center">
                  <button
                    onClick={closeLangPanel}
                    className="px-10 py-4 rounded-full bg-gray-200 hover:bg-gray-300 active:scale-95 text-2xl font-bold text-gray-700 transition-all"
                  >
                    {ui.cancel}
                  </button>
                </div>
              </>
            ) : pendingLang && pendingLangConfig && pendingUi ? (
              <>
                <div className="flex flex-col items-center gap-3">
                  <span className="text-7xl leading-none">{pendingLangConfig.flag}</span>
                  <span className="text-4xl font-bold text-gray-900">{pendingLangConfig.label}</span>
                </div>
                {/* 変更後の言語で尋ねる。押し間違えても意味が分かるよう今の言語でも併記する。 */}
                <p className="mt-8 text-3xl font-bold text-gray-900 text-center leading-snug">{pendingUi.confirmQ}</p>
                <p className="mt-2 text-xl text-gray-500 text-center">{ui.confirmQ}</p>
                <div className="mt-10 flex items-center justify-center gap-5">
                  <button
                    onClick={closeLangPanel}
                    className="px-10 py-4 rounded-full bg-gray-200 hover:bg-gray-300 active:scale-95 text-2xl font-bold text-gray-700 transition-all"
                  >
                    {ui.cancel}
                  </button>
                  <button
                    onClick={confirmLangChange}
                    className="px-10 py-4 rounded-full bg-[#8b5cf6] hover:bg-[#7c3aed] active:scale-95 text-2xl font-bold text-white shadow-lg transition-all"
                  >
                    {pendingUi.confirmYes}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-3xl font-bold text-gray-900 text-center">{ui.langPick}</p>
                <div className="mt-8 grid grid-cols-4 gap-4">
                  {SUPPORTED_LANGS.map((l) => (
                    <button
                      key={l.code}
                      onClick={() => setPendingLang(l.code)}
                      disabled={l.code === userLang}
                      className={`flex flex-col items-center gap-2 rounded-2xl p-5 border-2 transition-all ${
                        l.code === userLang
                          ? "border-[#8b5cf6] bg-violet-50 opacity-60"
                          : "border-gray-200 hover:border-[#8b5cf6] hover:bg-violet-50 active:scale-95"
                      }`}
                    >
                      <span className="text-5xl leading-none">{l.flag}</span>
                      <span className="text-base font-medium text-gray-800">{l.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-8 flex justify-center">
                  <button
                    onClick={closeLangPanel}
                    className="px-10 py-4 rounded-full bg-gray-200 hover:bg-gray-300 active:scale-95 text-2xl font-bold text-gray-700 transition-all"
                  >
                    {ui.cancel}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
