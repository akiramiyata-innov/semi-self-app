"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { PhoneCall, PhoneOff, Mic, Check, MessageSquareText } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { Flag } from "@/components/Flag";
import { KioskHeader } from "@/components/KioskHeader";
import { ScreenShareView } from "@/components/ScreenShareView";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { unlockAudioContext } from "@/lib/audioUnlock";
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition";
import type { MicErrorCode } from "@/hooks/useSpeechRecognition";
import { useScreenCapture } from "@/hooks/useScreenCapture";
import { installClientErrorReporter } from "@/lib/clientErrorReporter";
import { notifyCallEnded } from "@/lib/kioskNotify";
import type { CallEndStatus } from "@/lib/kioskNotify";
import type { TranscriptEntry } from "@/lib/types";
import type { LangCode } from "@/lib/socketEvents";

type Phase = "lang-select" | "idle" | "calling" | "in-call" | "ended" | "rejected" | "no-staff" | "call-timeout" | "disconnected" | "staff-disconnected";

// Error messages per language (U1/U2/U3)
const ERR: Record<string, { noStaff: string; noStaffSub: string; busy: string; busySub: string; disconnected: string; disconnectedSub: string; staffDisconnected: string; staffDisconnectedSub: string; serverDown: string }> = {
  ja: { noStaff: "係員が不在です", noStaffSub: "しばらく後にもう一度お試しください。", busy: "ただいま混み合っています", busySub: "しばらくたってから、もう一度お呼び出しください。", disconnected: "接続が切れました", disconnectedSub: "ネットワークを確認して、もう一度お試しください。", staffDisconnected: "係員との接続が切れました", staffDisconnectedSub: "もう一度お呼び出しください。", serverDown: "サーバーに接続できません。ネットワークをご確認ください。" },
  en: { noStaff: "No staff available", noStaffSub: "Please try again later.", busy: "All staff are busy now", busySub: "Please try calling again in a little while.", disconnected: "Connection lost", disconnectedSub: "Please check your network and try again.", staffDisconnected: "Staff connection lost", staffDisconnectedSub: "Please call again.", serverDown: "Cannot connect to server. Please check your network." },
  zh: { noStaff: "暂无工作人员", noStaffSub: "请稍后再试。", busy: "工作人员正忙", busySub: "请稍后再次呼叫。", disconnected: "连接中断", disconnectedSub: "请检查网络并重试。", staffDisconnected: "与工作人员的连接中断", staffDisconnectedSub: "请再次呼叫。", serverDown: "无法连接到服务器，请检查网络。" },
  "zh-TW": { noStaff: "暫無服務人員", noStaffSub: "請稍後再試。", busy: "服務人員忙線中", busySub: "請稍後再次呼叫。", disconnected: "連線中斷", disconnectedSub: "請檢查網路並重試。", staffDisconnected: "與服務人員的連線中斷", staffDisconnectedSub: "請再次呼叫。", serverDown: "無法連線到伺服器，請檢查網路。" },
  ko: { noStaff: "담당자 부재 중", noStaffSub: "잠시 후 다시 시도해 주세요.", busy: "지금은 담당자가 모두 응대 중입니다", busySub: "잠시 후 다시 호출해 주세요.", disconnected: "연결이 끊어졌습니다", disconnectedSub: "네트워크를 확인하고 다시 시도하세요.", staffDisconnected: "담당자와의 연결이 끊어졌습니다", staffDisconnectedSub: "다시 호출해 주세요.", serverDown: "서버에 연결할 수 없습니다. 네트워크를 확인하세요." },
  fr: { noStaff: "Aucun agent disponible", noStaffSub: "Veuillez réessayer plus tard.", busy: "Tous les agents sont occupés", busySub: "Veuillez rappeler dans un instant.", disconnected: "Connexion perdue", disconnectedSub: "Vérifiez votre réseau et réessayez.", staffDisconnected: "Connexion avec l'agent perdue", staffDisconnectedSub: "Veuillez rappeler.", serverDown: "Impossible de se connecter au serveur." },
  es: { noStaff: "Sin personal disponible", noStaffSub: "Por favor, inténtelo más tarde.", busy: "Todo el personal está ocupado", busySub: "Por favor, vuelva a llamar en unos minutos.", disconnected: "Conexión perdida", disconnectedSub: "Verifique su red e inténtelo de nuevo.", staffDisconnected: "Se perdió la conexión con el agente", staffDisconnectedSub: "Por favor, vuelva a llamar.", serverDown: "No se puede conectar al servidor." },
  th: { noStaff: "ไม่มีเจ้าหน้าที่", noStaffSub: "กรุณาลองใหม่ภายหลัง", busy: "ขณะนี้เจ้าหน้าที่ไม่ว่าง", busySub: "กรุณาเรียกอีกครั้งในภายหลัง", disconnected: "การเชื่อมต่อขาดหาย", disconnectedSub: "กรุณาตรวจสอบเครือข่ายและลองใหม่", staffDisconnected: "การเชื่อมต่อกับเจ้าหน้าที่ขาดหาย", staffDisconnectedSub: "กรุณาโทรหาอีกครั้ง", serverDown: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้" },
};

// 通話中の画面に出す文言。お客様が選んだ言語で表示する（日本語は翻訳が入らないので
// 注釈も「文字起こし」だけにする）。訳文は日本語へ訳し戻して意味を確認済み。
const UI_TEXT: Record<string, {
  delivered: string; composing: string; heading: string; notice: string;
  // cancel はポップアップを閉じる「キャンセル」専用。通話を切る画面下のボタンは
  // endCall（＝「通話終了」）。**同じ語を使い回すと、片方を直したときにもう片方まで
  // 変わってしまう**ので分けてある。
  cancel: string; endCall: string;
  // micOn=聞き取り中／micOff=止まっている（理由は問わず同じ表示にする）。
  // micOnNote はONのときの補足（「話してよい」ことを伝える一行）。
  micOn: string; micOnNote: string; micOff: string;
  // 通話中の言語変更まわり。confirmQ / confirmYes は「変更後の言語」で表示する確認の文言。
  // ※以前あった langLocked（マイクON中は変更できない旨の説明）は、言語選択の間だけ
  //   マイクを自動で止める方式にしたため不要になり削除した。
  langChange: string; langPick: string; confirmQ: string; confirmYes: string;
  // 会話のテキスト表示スイッチの見出し。ON/OFFはスイッチの絵と英字で示すため、
  // 文言は「何のスイッチか」だけを各言語で持つ。
  // ※2026-08-07に「メッセージ表示」→「文字起こし」へ変更（この機能が実際にしていることは
  //   話した内容を文字にすることなので）。**外国語7言語の訳語は母語話者の確認が未了**。
  textLabel: string;
  // 音声合成に失敗して文字だけになったときの説明。
  voiceFailed: string;
}> = {
  ja: {
    delivered: "係員に伝わりました", composing: "係員が回答を準備しています",
    heading: "ご用件をお伺いします。", cancel: "キャンセル", endCall: "通話終了",
    notice: "実際の係員との会話を、AIによる「音声発話」「翻訳」「文字起こし」等を用いて行います。通話中はマイクがONのままになります。",
    micOn: "マイクON", micOnNote: "どうぞお話しください", micOff: "マイク停止中",
    langChange: "言語を変える", langPick: "言語をお選びください",
    confirmQ: "この言語に変更しますか？", confirmYes: "変更する",
    textLabel: "文字起こし",
    voiceFailed: "音声をお届けできませんでした。文章をご覧ください。",
  },
  en: {
    delivered: "Delivered to staff", composing: "Staff is preparing a reply",
    heading: "How may we help you?", cancel: "Cancel", endCall: "End Call",
    notice: "You are talking with a real staff member. AI provides the spoken voice, the translation and the transcription. The microphone stays on during the call.",
    micOn: "Mic ON", micOnNote: "Please speak", micOff: "Mic OFF",
    langChange: "Change language", langPick: "Please select your language",
    confirmQ: "Change to this language?", confirmYes: "Change",
    textLabel: "Transcript",
    voiceFailed: "The voice could not be played. Please read the message above.",
  },
  zh: {
    delivered: "已送达工作人员", composing: "工作人员正在准备回复",
    heading: "请问有什么可以帮您？", cancel: "Cancel", endCall: "End Call",
    notice: "您正在与真人工作人员对话。语音播报、翻译、文字记录等由AI提供。通话期间麦克风将保持开启。",
    micOn: "Mic ON", micOnNote: "请讲话", micOff: "Mic OFF",
    langChange: "更改语言", langPick: "请选择语言",
    confirmQ: "要更改为该语言吗？", confirmYes: "更改",
    textLabel: "文字记录",
    voiceFailed: "语音无法播放，请阅读上面的文字。",
  },
  "zh-TW": {
    delivered: "已送達服務人員", composing: "服務人員正在準備回覆",
    heading: "請問有什麼可以為您服務？", cancel: "Cancel", endCall: "End Call",
    notice: "您正在與真人服務人員對話。語音播報、翻譯、文字記錄等由AI提供。通話期間麥克風將保持開啟。",
    micOn: "Mic ON", micOnNote: "請說話", micOff: "Mic OFF",
    langChange: "變更語言", langPick: "請選擇語言",
    confirmQ: "要變更為此語言嗎？", confirmYes: "變更",
    textLabel: "文字記錄",
    voiceFailed: "語音無法播放，請閱讀上方的文字。",
  },
  ko: {
    delivered: "담당자에게 전달되었습니다", composing: "담당자가 답변을 준비하고 있습니다",
    heading: "무엇을 도와드릴까요?", cancel: "Cancel", endCall: "End Call",
    notice: "실제 담당자와 대화하고 있습니다. 음성 발화, 번역, 텍스트 변환 등은 AI가 제공합니다. 통화 중에는 마이크가 켜진 상태로 유지됩니다.",
    micOn: "Mic ON", micOnNote: "말씀해 주세요", micOff: "Mic OFF",
    langChange: "언어 변경", langPick: "언어를 선택해 주세요",
    confirmQ: "이 언어로 변경하시겠습니까?", confirmYes: "변경",
    textLabel: "텍스트 변환",
    voiceFailed: "음성을 재생하지 못했습니다. 위의 문장을 읽어 주세요.",
  },
  fr: {
    delivered: "Transmis à l'agent", composing: "L'agent prépare une réponse",
    heading: "Comment pouvons-nous vous aider ?", cancel: "Cancel", endCall: "End Call",
    notice: "Vous parlez avec un agent réel. L'IA fournit la voix, la traduction et la transcription. Le micro reste activé pendant l'appel.",
    micOn: "Mic ON", micOnNote: "Parlez, s'il vous plaît", micOff: "Mic OFF",
    langChange: "Changer de langue", langPick: "Veuillez choisir votre langue",
    confirmQ: "Changer pour cette langue ?", confirmYes: "Changer",
    textLabel: "Transcription",
    voiceFailed: "La voix n'a pas pu être diffusée. Veuillez lire le message ci-dessus.",
  },
  es: {
    delivered: "Enviado al personal", composing: "El personal está preparando una respuesta",
    heading: "¿En qué podemos ayudarle?", cancel: "Cancel", endCall: "End Call",
    notice: "Está hablando con un agente real. La IA proporciona la voz, la traducción y la transcripción. El micrófono permanece activado durante la llamada.",
    micOn: "Mic ON", micOnNote: "Hable, por favor", micOff: "Mic OFF",
    langChange: "Cambiar idioma", langPick: "Seleccione su idioma",
    confirmQ: "¿Cambiar a este idioma?", confirmYes: "Cambiar",
    textLabel: "Transcripción",
    voiceFailed: "No se pudo reproducir la voz. Lea el mensaje anterior.",
  },
  th: {
    delivered: "ส่งถึงเจ้าหน้าที่แล้ว", composing: "เจ้าหน้าที่กำลังเตรียมคำตอบ",
    heading: "มีอะไรให้เราช่วยเหลือไหม", cancel: "Cancel", endCall: "End Call",
    notice: "คุณกำลังสนทนากับเจ้าหน้าที่จริง โดยใช้ AI ในการอ่านออกเสียง การแปล และการถอดข้อความ ไมโครโฟนจะเปิดอยู่ตลอดการสนทนา",
    micOn: "Mic ON", micOnNote: "เชิญพูดได้เลย", micOff: "Mic OFF",
    langChange: "เปลี่ยนภาษา", langPick: "กรุณาเลือกภาษา",
    confirmQ: "ต้องการเปลี่ยนเป็นภาษานี้หรือไม่", confirmYes: "เปลี่ยน",
    textLabel: "ถอดข้อความ",
    voiceFailed: "ไม่สามารถเล่นเสียงได้ กรุณาอ่านข้อความด้านบน",
  },
};

// マイク／音声認識のエラー文言。フックはコードだけを返すので、お客様が選んだ言語で
// ここで文章にする（従来は日本語がフック内に直接書かれており、外国語のお客様には
// 読めなかった）。キオスクではお客様がブラウザ設定を直せないため、機器の問題は
// 「係員が対応します」と伝え、係員側にも通知する（user:micError）。
const MIC_ERR: Record<string, Record<MicErrorCode, string>> = {
  ja: {
    "mic-denied": "マイクを使用できません。係員が対応します。",
    "mic-not-found": "マイクが見つかりません。係員が対応します。",
    "network": "通信が不安定です。少し待ってからもう一度お試しください。",
    "service-unavailable": "音声認識を利用できません。係員が対応します。",
    "no-connection": "サーバーに接続できていません。少し待ってからもう一度お試しください。",
    "unknown": "音声を認識できませんでした。もう一度お試しください。",
  },
  en: {
    "mic-denied": "The microphone cannot be used. Our staff will assist you.",
    "mic-not-found": "No microphone was found. Our staff will assist you.",
    "network": "The connection is unstable. Please wait a moment and try again.",
    "service-unavailable": "Speech recognition is unavailable. Our staff will assist you.",
    "no-connection": "Not connected to the server. Please wait a moment and try again.",
    "unknown": "Your speech could not be recognized. Please try again.",
  },
  zh: {
    "mic-denied": "无法使用麦克风。工作人员将为您处理。",
    "mic-not-found": "未找到麦克风。工作人员将为您处理。",
    "network": "网络不稳定，请稍候再试。",
    "service-unavailable": "无法使用语音识别。工作人员将为您处理。",
    "no-connection": "未连接到服务器，请稍候再试。",
    "unknown": "未能识别您的语音，请再试一次。",
  },
  "zh-TW": {
    "mic-denied": "無法使用麥克風。服務人員將為您處理。",
    "mic-not-found": "找不到麥克風。服務人員將為您處理。",
    "network": "網路不穩定，請稍候再試。",
    "service-unavailable": "無法使用語音辨識。服務人員將為您處理。",
    "no-connection": "未連線到伺服器，請稍候再試。",
    "unknown": "未能辨識您的語音，請再試一次。",
  },
  ko: {
    "mic-denied": "마이크를 사용할 수 없습니다. 담당자가 대응합니다.",
    "mic-not-found": "마이크를 찾을 수 없습니다. 담당자가 대응합니다.",
    "network": "통신이 불안정합니다. 잠시 후 다시 시도해 주세요.",
    "service-unavailable": "음성 인식을 사용할 수 없습니다. 담당자가 대응합니다.",
    "no-connection": "서버에 연결되어 있지 않습니다. 잠시 후 다시 시도해 주세요.",
    "unknown": "음성을 인식하지 못했습니다. 다시 시도해 주세요.",
  },
  fr: {
    "mic-denied": "Le micro ne peut pas être utilisé. Un agent va vous aider.",
    "mic-not-found": "Aucun micro détecté. Un agent va vous aider.",
    "network": "La connexion est instable. Veuillez patienter et réessayer.",
    "service-unavailable": "La reconnaissance vocale est indisponible. Un agent va vous aider.",
    "no-connection": "Non connecté au serveur. Veuillez patienter et réessayer.",
    "unknown": "Votre voix n'a pas pu être reconnue. Veuillez réessayer.",
  },
  es: {
    "mic-denied": "No se puede usar el micrófono. Un agente le atenderá.",
    "mic-not-found": "No se ha encontrado ningún micrófono. Un agente le atenderá.",
    "network": "La conexión es inestable. Espere un momento e inténtelo de nuevo.",
    "service-unavailable": "El reconocimiento de voz no está disponible. Un agente le atenderá.",
    "no-connection": "Sin conexión con el servidor. Espere un momento e inténtelo de nuevo.",
    "unknown": "No se pudo reconocer su voz. Inténtelo de nuevo.",
  },
  th: {
    "mic-denied": "ไม่สามารถใช้ไมโครโฟนได้ เจ้าหน้าที่จะช่วยเหลือคุณ",
    "mic-not-found": "ไม่พบไมโครโฟน เจ้าหน้าที่จะช่วยเหลือคุณ",
    "network": "การเชื่อมต่อไม่เสถียร กรุณารอสักครู่แล้วลองใหม่",
    "service-unavailable": "ไม่สามารถใช้การรู้จำเสียงได้ เจ้าหน้าที่จะช่วยเหลือคุณ",
    "no-connection": "ไม่ได้เชื่อมต่อกับเซิร์ฟเวอร์ กรุณารอสักครู่แล้วลองใหม่",
    "unknown": "ไม่สามารถรู้จำเสียงของคุณได้ กรุณาลองใหม่",
  },
};

/** 係員から解除通知が届かない場合でも「準備しています」が残り続けないようにする保険。 */
const COMPOSING_MAX_MS = 60_000;
/**
 * 係員の声が途切れてから「回答を準備しています」を消すまでの時間。
 *
 * ★係員のマイクは会話中つけっぱなしにできる。サーバーは**声を検知するたび**に
 * この案内を送ってくるので、話している間は点きっぱなしになり、話をやめれば
 * ここで消える。これが無いと、係員が答え終えたあともマイクをONにしている限り
 * 「準備しています」が出続け、お客様が話し出せない（2026-08-17 ユーザー報告）。
 * 合成中（synthesizing）は返事が届くまで消さないので、上の保険のほうを使う。
 */
const COMPOSING_IDLE_MS = 6_000;
/** アバターが話し終えてから発話検知を再開するまでの余韻（スピーカーの残響・反響対策）。 */
const AVATAR_TAIL_MS = 500;
/**
 * 通話終了のとき、アバターの読み上げが終わるのを待つ上限。
 * 合成に失敗して音声が来ないまま黙り込む事故に備えた歯止めで、ここに達したら
 * 待たずに終了画面へ進む。台本の係員のセリフは最長でも50字程度＝10秒弱なので、
 * 通常の読み上げがこの上限に当たることはない。
 */
const END_WAIT_MAX_MS = 15_000;
/** 音声を出せなかったとき、文字を読む時間として置く間（そのあと終了画面へ進む）。 */
const NO_AUDIO_GRACE_MS = 3_000;

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

// 通話終了ボタン。以前は薄い藤色で、周りの淡い配色に埋もれて気づかれにくかった。
// 電話を切る操作は世界共通で赤なので、8言語のどのお客様にも意味が伝わる。
// **隣のマイクONは淡い桃色**なので、濃さでも色みでもはっきり違うものを選んでいる。
const END_CALL_BUTTON = {
  background: "linear-gradient(180deg, #f87171 0%, #dc2626 100%)",
} as const;

// マイクボタン。キャンセルと同じ「立体的な丸ボタン」の見た目にそろえたうえで、
// 「聞き取り中」か「止まっている」かの2つだけを色で分ける。
// **止まっている理由（読み上げ中／手動／言語選択中）で見た目は変えない**
// （2026-08-12 ユーザー指定）。お客様に必要なのは「今は声が届かない」ことだけで、
// 理由ごとに色や文言が変わるとかえって分かりにくいため。
// 止まっているときは**黒地に白抜き**＝薄い灰色だと「押せない・壊れている」ようにも
// 見えるので、強い対比で「止まっている」ことを示す。
const MIC_BUTTON_OFF = {
  background: "linear-gradient(180deg, #374151 0%, #111827 100%)",
} as const;

const MIC_BUTTON_ON = {
  background: "linear-gradient(180deg, #fde7f0 0%, #f4a6c6 100%)",
} as const;

/**
 * 通話の終わり方と、窓処サーバへ知らせる status の対応（2026-08-20）。
 * ここに載っている phase になったら1回だけ通知する。**終了経路が増えても
 * 送り忘れないよう、送信は1か所（下の useEffect）だけにしてある。**
 *
 * `from` は「その終わり方があり得る直前の画面」。ここを見るのは、
 * **前の通話の終了の合図が、次の呼び出しの最中に届くことがある**ため
 * （同じ端末から呼び直すと、サーバーが前の通話を終わらせて call:ended を送る＝
 * socketServer.ts の「同じ端末からの再呼び出し」）。そのまま通知すると、
 * 通話が始まった直後に窓処端末が待機画面へ戻ってしまう。
 * 「通話終了」は通話中(in-call)からしか起こらないので、それで見分けられる。
 */
const END_STATUS: Partial<Record<Phase, { status: CallEndStatus; from: Phase[] }>> = {
  // どちらかが「通話終了」を押した（通話中からしか起こらない）
  "ended": { status: "ended", from: ["in-call"] },
  // 係員が断った／応答できる係員がいなかった／誰も応答しないまま打ち切り（呼び出し中）
  "rejected": { status: "rejected", from: ["calling"] },
  "no-staff": { status: "no-staff", from: ["calling"] },
  "call-timeout": { status: "call-timeout", from: ["calling"] },
  // 通話中に係員の接続が切れた
  "staff-disconnected": { status: "staff-disconnected", from: ["in-call"] },
  // お客様側（窓処端末）の通信が切れた。呼び出し中でも通話中でも起こる
  "disconnected": { status: "user-offline", from: ["calling", "in-call"] },
};

interface UserScreenProps {
  machineId: string;
  machineName: string;
  stationId?: string;
  line?: string;
  stationName?: string;
  stationCode?: string;
  /** 窓処サーバの宛先。page.tsx で端末自身かどうかを確かめてある。 */
  notifyUrl?: string;
}

export function UserScreen({ machineId, machineName, stationId = "", line, stationName, stationCode, notifyUrl }: UserScreenProps) {
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
  /**
   * これから鳴らす音声の置き場と、その合図（v1.43.0）。
   *
   * 1つの返答が**文ごとに何回かに分けて**届くようになったため、state で
   * 「最後に届いた1つ」を持つ方式では取りこぼす（同じ瞬間に2つ届くと前が消える／
   * 中身が同じ2文だと変化なしとみなされて鳴らない）。箱に積む方式に変えた。
   */
  const audioQueueRef = useRef<string[]>([]);
  const [audioTick, setAudioTick] = useState(0);
  /**
   * この返答の音声がまだ続くか（v1.43.0）。文ごとに分けて届くので、1つ鳴らし終えた
   * だけでは読み上げ終了と判断できない。サーバーの `tts:done` で終わりを知る。
   */
  const [moreAudioComing, setMoreAudioComing] = useState(false);
  // 前の返答の残りは、通話の切り替わり時などに `audioQueueRef.current = []` で捨てる。

  const [staffScreenFrame, setStaffScreenFrame] = useState<string | null>(null);
  // 通話中の言語変更。パネルを開いてから言語を選び、確認してはじめて切り替わる。
  const [langPanelOpen, setLangPanelOpen] = useState(false);
  const [pendingLang, setPendingLang] = useState<LangCode | null>(null);
  // 会話のテキストを画面に出すか。**既定は非表示**。お客様側・係員側のどちらからでも
  // 切り替えられ、状態はサーバーが持つ（後から操作したほうが勝つ）。
  const [textVisible, setTextVisible] = useState(false);
  // 音声を届けられなかった発言のid。テキスト非表示の設定でも、この分だけは文字を出す
  // （音声も文字も無い＝お客様に何も届かない状態を防ぐための例外）。
  const [forcedTextIds, setForcedTextIds] = useState<string[]>([]);
  const [showConnectWarning, setShowConnectWarning] = useState(false);
  const [deliveredIds, setDeliveredIds] = useState<string[]>([]); // 係員に届いた発言のid
  const [staffComposing, setStaffComposing] = useState(false);    // 係員が回答を準備中
  /** 「準備しています」の合図を受けるたびに増やす（自動で消えるまでを数え直すため）。 */
  const [composingSignal, setComposingSignal] = useState(0);
  /** いまの「準備しています」が合成中（返事が確実に来る）によるものか。 */
  const composingSynthesizingRef = useRef(false);
  const connectWarningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const userLangRef = useRef<LangCode>("ja");
  const micOnRef = useRef(false);
  /** 言語選択の画面を開いているか。開いている間はマイクを一時停止する。 */
  const langPanelOpenRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  /** 発言を1件追加し、そのidを返す（お客様の発言は「係員に伝わりました」の照合に使う）。 */
  const addEntry = useCallback((entry: Omit<TranscriptEntry, "id" | "timestamp">) => {
    const id = makeId();
    setTranscript((prev) => [...prev, { ...entry, id, timestamp: Date.now() }]);
    return id;
  }, []);

  const langConfig = SUPPORTED_LANGS.find((l) => l.code === userLang);

  const { start: startMic, stop: stopMic, listening, muted: micMuted, setMuted: setMicMuted, error: micError } = useSpeechRecognition({
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

  /**
   * カメラの取得失敗を種類つきでサーバーへ申告する（C-1）。障害履歴に残り、
   * 通話中なら係員画面の「映像なし」の枠に理由が出る。導入後の窓処端末は
   * 直接調べられないため、この申告が唯一の手がかりになる。
   */
  const reportCameraError = useCallback((camera: "face" | "hand" | "detect", err: unknown) => {
    const name = (err as { name?: string } | null)?.name ?? "";
    const code =
      name === "NotAllowedError" || name === "SecurityError" ? "denied"
      : name === "NotFoundError" ? "not-found"
      : name === "NotReadableError" || name === "AbortError" ? "in-use"
      : name === "OverconstrainedError" ? "gone"
      : "error";
    socketRef.current?.emit("camera:error", {
      sessionId: sessionIdRef.current ?? undefined,
      machineName,
      camera,
      code,
      detail: String((err as Error | null)?.message ?? err ?? "").slice(0, 120),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineName]);

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
      reportCameraError("detect", e); // 許可なし・他アプリが使用中・未接続などを記録
      cameraDevicesRef.current = {};
    }
    return cameraDevicesRef.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    onError: (err) => reportCameraError("face", err),
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
    onError: (err) => reportCameraError("hand", err),
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
    if (micError === "mic-denied" || micError === "mic-not-found") {
      micOnRef.current = false;
    }
  }, [micError]);

  /**
   * いま「聞き取りを止めておくべき」理由があるか。マイクを入れる/戻すすべての場所で
   * これ1つを見る。理由を各所で書き写すと、v1.30.4 のような
   * 「場所によって判断が食い違う」不具合の元になるため。
   * 理由は3つ: ①アバターが読み上げ中 ②これから読み上げが届く ③言語選択の画面を開いている。
   */
  const shouldPauseMic = useCallback(
    () => avatarSpeakingRef.current || speechPendingRef.current || langPanelOpenRef.current,
    []
  );

  const toggleMic = useCallback(() => {
    if (micOnRef.current) {
      stopMic();
      micOnRef.current = false;
    } else {
      // Clear echo detection ref: by the time user manually presses mic, TTS is done
      lastAvatarTextRef.current = "";
      micOnRef.current = true;
      startMic(langConfig?.bcp47);
      // 一時停止の印はONにする側で毎回計算し直す。止めるべき理由があればその状態で
      // 始め（理由が消え次第、自動再開の経路で解除される）、無ければ必ず解除する——
      // OFFの間に係員の発話があると印だけが立ったまま残り、次のONが「停止中」で
      // 始まってしまうため。
      if (STREAMING_STT) setMicMuted(shouldPauseMic());
    }
  }, [stopMic, startMic, langConfig, setMicMuted, shouldPauseMic]);

  /** 言語選択の画面を開く。開いている間はマイクを一時停止する（選んでいる声を拾わない）。 */
  const openLangPanel = useCallback(() => {
    langPanelOpenRef.current = true;
    setLangPanelOpen(true);
    if (STREAMING_STT && micOnRef.current) setMicMuted(true);
  }, [setMicMuted]);

  /**
   * 通話中の言語変更を確定する。マイクが動いているときは**認識を新しい言語で開き直す**
   * （認識のストリームは開いたときの言語のままなので、そのままだと前の言語で聞き続ける）。
   * 翻訳とアバターの声はサーバーが毎回この言語を見るため、切り替えた直後から新しい言語になる。
   */
  const confirmLangChange = useCallback(() => {
    if (!pendingLang) return;
    const nextBcp47 = SUPPORTED_LANGS.find((l) => l.code === pendingLang)?.bcp47;
    setUserLang(pendingLang);
    setPendingLang(null);
    langPanelOpenRef.current = false;
    setLangPanelOpen(false);
    const sid = sessionIdRef.current;
    if (sid) socketRef.current?.emit("session:setLang", { sessionId: sid, lang: pendingLang });
    if (STREAMING_STT && micOnRef.current) {
      stopMic();
      startMic(nextBcp47);
      setMicMuted(shouldPauseMic());
    }
  }, [pendingLang, stopMic, startMic, setMicMuted, shouldPauseMic]);

  /** 言語選択の画面を閉じる（変更せずに戻る場合も含む）。マイクは元の状態へ戻す。 */
  const closeLangPanel = useCallback(() => {
    langPanelOpenRef.current = false;
    setLangPanelOpen(false);
    setPendingLang(null);
    if (STREAMING_STT && micOnRef.current) setMicMuted(shouldPauseMic());
  }, [setMicMuted, shouldPauseMic]);

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
  // 直近の係員の発言id。音声を再生できなかったとき、この発言を文字で出す。
  const lastStaffEntryIdRef = useRef<string | null>(null);

  // Pause mic when tab goes to background (prevents cross-tab audio pickup)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        if (micOnRef.current) stopMic();
      } else {
        if (micOnRef.current) {
          startMic(langConfig?.bcp47);
          // 復帰時も一時停止の印を計算し直す（止める理由が残っていればその状態で始める）
          if (STREAMING_STT) setMicMuted(shouldPauseMic());
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [stopMic, startMic, langConfig, setMicMuted, shouldPauseMic]);

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
        audioQueueRef.current = []; setMoreAudioComing(false); // 前の返答の残りを捨てる
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

  /**
   * 窓処サーバへ「通話が終わった」ことを知らせる（2026-08-20）。
   *
   * 終わり方は7種類あるが、**窓処側は type しか見ない**ため、すべて
   * type=CALL_ENDED で送り、どの終わり方だったかは status に入れる。
   *
   * 終了経路ごとに書くと増えたときに送り忘れるので、**画面の状態（phase）が
   * 終了を表す値になった瞬間に1回だけ送る**方式にしてある。
   * 「通話終了」を押したときは、アバターの読み上げが終わってから phase が
   * "ended" になる。**読み上げの途中で窓処端末の画面が待機に戻らない**ため、
   * この方式のほうが都合がよい。
   */
  const prevPhaseRef = useRef<Phase>(phase);
  const lastSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionId) lastSessionIdRef.current = sessionId;   // 終了時には消えていることがある
  }, [sessionId]);
  useEffect(() => {
    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;
    const end = END_STATUS[phase];
    if (!end || !end.from.includes(prev)) return;
    notifyCallEnded({ base: notifyUrl, status: end.status, machineId, sessionId: lastSessionIdRef.current });
  }, [phase, notifyUrl, machineId]);

  // 画面のプログラムエラーをサーバーの障害履歴へ申告する（提案②）。
  // 導入後の窓処端末は直接調べられないため、端末側で起きたことを残す唯一の経路。
  useEffect(() => {
    return installClientErrorReporter(() => socketRef.current, "user", () => machineName);
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    audioQueueRef.current = []; setMoreAudioComing(false); // 前の返答の残りを捨てる
    setDeliveredIds([]);
    setStaffComposing(false);
    // テキスト表示は通話ごとに既定（非表示）へ戻す。前のお客様の設定を引き継がない。
    setTextVisible(false);
    setForcedTextIds([]);
    setLangPanelOpen(false);
    langPanelOpenRef.current = false;
    setPendingLang(null);
    // 読み上げ待ちの印を次の通話へ持ち越さない
    speechPendingRef.current = false;
    avatarSpeakingRef.current = false;
    pendingEndRef.current = null;
  }, [stopMic]);

  /**
   * 「知らせを数秒見せてから待機画面へ戻す」ときの後始末（v1.48.0・2026-08-21）。
   *
   * ★戻す処理は数秒あとに走るため、**その間に次の通話が始まっていることがある**。
   *   サーバーは同じ端末から呼び直されると、新しい通話を作る**直前に**前の通話へ
   *   終了を知らせる（socketServer.ts「同じ端末からの再呼び出し」）。お客様の画面には
   *
   *     call:ended(前の通話) → call:requested(新) → call:answered(新)
   *
   *   の順で届くので、そのまま3秒後に戻すと、**係員は通話中なのにお客様画面だけ
   *   言語選択へ落ちる**（再現済み）。戻す直前に「まだあの通話のままか」を確かめる。
   *
   * @param callId 戻そうとしている通話。null なら通話に紐づかない案内（確認しない）
   */
  const laterIfSameCall = useCallback((callId: string | null, ms: number, run: () => void) => {
    setTimeout(() => {
      // 別の通話が始まっている＝その画面を消してはいけない。
      // 何も始まっていなければ（null）予定どおり戻す。
      if (callId !== null && sessionIdRef.current !== null && sessionIdRef.current !== callId) return;
      run();
    }, ms);
  }, []);

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
      // 常時ON方式: 通話がつながったらマイクを自動でONにする（切り替え忘れ対策）。
      // 以後、手動でOFFにするまでONのまま。アバターの読み上げ中だけ自動で一時停止する。
      if (STREAMING_STT) {
        lastAvatarTextRef.current = "";
        micOnRef.current = true;
        startMic(SUPPORTED_LANGS.find((l) => l.code === userLangRef.current)?.bcp47);
      }
    });

    s.on("call:noStaff", () => {
      // U2: no responsive staff at all
      setPhase("no-staff");
      setTimeout(() => setPhase("idle"), 5000);
    });

    s.on("call:timeout", (payload?: { sessionId?: string }) => {
      // 係員は在席しているが、誰も応答しないまま打ち切り時間が過ぎた。
      // お客様を無期限に待たせず「混み合っています」を出して待機画面へ戻す。
      const callId = sessionIdRef.current;
      if (payload?.sessionId && callId && payload.sessionId !== callId) return; // 前の呼び出しあて
      setSessionId(null);
      sessionIdRef.current = null;
      setPhase("call-timeout");
      laterIfSameCall(callId, 5000, () => setPhase("idle"));
    });

    s.on("call:rejected", (payload?: { sessionId?: string }) => {
      // Staff declined — show message briefly then return to lang-select
      const callId = sessionIdRef.current;
      if (payload?.sessionId && callId && payload.sessionId !== callId) return; // 前の呼び出しあて
      setPhase("rejected");
      setSessionId(null);
      sessionIdRef.current = null;
      laterIfSameCall(callId, 3000, () => setPhase("lang-select"));
    });

    s.on("call:staffDisconnected", (payload?: { sessionId?: string }) => {
      const callId = sessionIdRef.current;
      if (payload?.sessionId && callId && payload.sessionId !== callId) return; // 前の通話あて
      setPhase("staff-disconnected");
      stopMic();
      micOnRef.current = false;
      laterIfSameCall(callId, 5000, () => {
        setPhase("idle");
        resetCallState();
      });
    });

    s.on("call:ended", (payload?: { sessionId?: string }) => {
      /**
       * ★どの通話あての終了かを必ず確かめる（v1.48.0・2026-08-21）。
       *
       * お客様の画面は通話の「部屋」から抜けない（サーバーが部屋から外すのは
       * 終了を押した側のソケットだけ＝socketServer.ts の call:end）。そのため
       * **前の通話あての終了通知が、あとから届くことがある**。
       */
      const callId = sessionIdRef.current;
      if (payload?.sessionId && callId && payload.sessionId !== callId) return;
      // ★読み上げが残っているなら、終わるまで画面を切り替えない。
      //   係員が「ありがとうございました」と言った直後に終了を押すのが自然な流れだが、
      //   そのままだと読み上げの途中で画面が消えてしまう。待つべき状態は2つある。
      //   ①もう鳴っている（avatarSpeaking）
      //   ②まだ鳴っていないが、これから届く（speechPending）
      //     ＝サーバーは翻訳・音声合成を終えてから送るので1〜2秒かかり、
      //       **その間に終了されると call:ended のほうが先に着く**（実測で確認）。
      //       「準備中(synthesizing)」の合図が先に届くので、それで判断している。
      const finish = () => {
        // ★この通話がもう入れ替わっているなら、画面には手を触れない。
        //   読み上げ待ちで数秒置いてから走ることがあるため、ここでも確かめる。
        if (callId && sessionIdRef.current && sessionIdRef.current !== callId) return;
        setPhase("ended");
        stopMic();
        micOnRef.current = false;
        // Return to lang-select after 3 seconds
        laterIfSameCall(callId, 3000, () => {
          setPhase("lang-select");
          resetCallState();
        });
      };
      // 「もう鳴っている」だけでなく「これから鳴る」場合も待つ。
      if (!avatarSpeakingRef.current && !speechPendingRef.current) { finish(); return; }
      // マイクだけは先に止める（読み上げの声を拾い続けないため）
      stopMic();
      micOnRef.current = false;
      pendingEndRef.current = finish;
      // 読み上げ終了の合図が来なかったときの保険（端末側の不具合で固まらないように）
      setTimeout(() => {
        const pending = pendingEndRef.current;
        if (pending) { pendingEndRef.current = null; pending(); }
      }, END_WAIT_MAX_MS);
    });

    // お客様の発言が係員の画面に届いた（既読チェックを表示する）
    s.on("speech:delivered", (payload: { clientId: string }) => {
      if (payload.clientId) setDeliveredIds((prev) => [...prev, payload.clientId]);
    });

    // 係員がマイクON／入力中＝回答を準備している
    s.on("staff:composing", (payload: { active: boolean; synthesizing?: boolean }) => {
      setStaffComposing(!!payload.active);
      // synthesizing＝係員の発言が確定し、いま翻訳・音声合成をしている最中。
      // **この合図は読み上げ本体より先に届く**ので、通話終了が先に来ても
      // 「返事がまだ来ていない」ことが分かる（係員のマイクONだけでは立てない）。
      if (payload.active && payload.synthesizing) speechPendingRef.current = true;
      if (payload.active) {
        composingSynthesizingRef.current = !!payload.synthesizing;
        // 声を検知するたびに届く合図。受けるたびに自動で消えるまでの時間を数え直す。
        setComposingSignal((n) => n + 1);
      }
    });

    // テキスト表示の切り替え。お客様側・係員側のどちらが押しても、サーバーが決めた
    // 状態がここへ届く。後から操作したほうが必ず勝つ。
    s.on("session:textVisible", (payload: { visible: boolean }) => {
      setTextVisible(!!payload.visible);
    });

    /**
     * 音声が届かなかった／途中で欠けたときの知らせ（対策10・2026-08-20）。
     *
     * 文字は音声より先に送られてくるため、送った時点では音声が出せるかどうか
     * まだ分からない。あとから「この発言は文字も出して」と伝えられる。
     * ★以前はサーバーが送っていたのに受け取る側が無く、機能していなかった。
     */
    s.on("tts:incomplete", () => {
      const id = lastStaffEntryIdRef.current;
      if (!id) return;
      setForcedTextIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
      // 音声は来ない（または途中で終わる）ので、読み上げ待ちの状態を解く
      speechPendingRef.current = false;
      setMoreAudioComing(false);
      setMicMuted(false);
      const pending = pendingEndRef.current;
      if (pending) { pendingEndRef.current = null; setTimeout(pending, NO_AUDIO_GRACE_MS); }
    });

    s.on("speech:staff", (payload: { text: string; isFinal: boolean; forceShowText?: boolean }) => {
      setStaffComposing(false); // 返事が来た（途中表示でも）＝準備中の表示は不要
      composingSynthesizingRef.current = false;
      if (payload.isFinal) {
        setInterimStaff("");
        const entryId = addEntry({ speaker: "staff", text: payload.text, isFinal: true });
        lastStaffEntryIdRef.current = entryId;
        // 音声を届けられなかった＝この1件は設定に関わらず文字で出す
        if (payload.forceShowText) setForcedTextIds((prev) => [...prev, entryId]);
        // これから読み上げが来る（＝音声が出せなかった場合を除く）。通話終了が
        // 押されても、読み上げ終わりまで画面を切り替えないための印。
        speechPendingRef.current = !payload.forceShowText;
        // 音声が来る予定＝読み上げが終わるまで「続きあり」にしておく
        setMoreAudioComing(!payload.forceShowText);
        if (payload.forceShowText) {
          // 音声が無いので読み上げ終了の合図は来ない。文字を読む間だけ置いて進める。
          const pending = pendingEndRef.current;
          if (pending) {
            pendingEndRef.current = null;
            setTimeout(pending, NO_AUDIO_GRACE_MS);
          }
        }
        audioQueueRef.current = []; setMoreAudioComing(false); // 前の返答の残りを捨てる
        lastAvatarTextRef.current = payload.text;
        if (STREAMING_STT) {
          // 常時ON方式: マイクは切らず、読み上げの間だけ一時停止（無音を送る）。
          // 読み上げ本体より先にこの確定が届くので、鳴り始める前に確実に止められる。
          // 音声が出せない発言(forceShowText)は再生が無いので止めない。
          if (!payload.forceShowText) setMicMuted(true);
        } else {
          // 旧方式: 係員の発話でマイクOFF（お客様がボタンで再開する）
          stopMic();
          micOnRef.current = false;
        }
        setInterimUser("");
      } else {
        setInterimStaff(payload.text);
      }
    });

    s.on("tts:audio", (payload: { audioBase64: string }) => {
      if (!payload.audioBase64) return;
      audioQueueRef.current.push(payload.audioBase64);
      setAudioTick((t) => t + 1);
    });

    // この返答の音声はこれで全部、の合図（文ごとに分けて届くため必要）
    s.on("tts:done", () => setMoreAudioComing(false));

    s.on("screen:share", (payload: { frameData: string }) => {
      setStaffScreenFrame(payload.frameData || null);
    });

    // 係員画面からお客様のマイクを入/切する（担当係員のみ・サーバーが確認済み）。
    // お客様のボタン操作と対等＝後から操作したほうが勝つ（テキスト表示スイッチと同じ考え方）。
    s.on("user:micControl", (payload: { on: boolean }) => {
      if (!STREAMING_STT) return;
      if (payload.on) {
        if (!micOnRef.current) {
          lastAvatarTextRef.current = "";
          micOnRef.current = true;
          startMic(SUPPORTED_LANGS.find((l) => l.code === userLangRef.current)?.bcp47);
        }
        // 止める理由が残っていればその状態で始める（理由が消え次第、自動で再開される）
        setMicMuted(shouldPauseMic());
      } else {
        micOnRef.current = false;
        stopMic();
      }
    });

    return () => { s.disconnect(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { userLangRef.current = userLang; }, [userLang]);

  // マイクの異常を係員へ知らせる。係員からは「話さないお客様」にしか見えず、
  // マイクの問題だと気づけないため。解消したら null を送って表示を消す。
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    socketRef.current?.emit("user:micError", { sessionId: sid, code: micError });
  }, [micError]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // textVisible / staffScreenFrame も見ているのは、文字起こしを途中でONにしたときや
    // 画面共有が始まって会話エリアの高さが変わったときに、いちばん新しい発言が
    // 隠れたままにならないようにするため。
  }, [transcript, interimStaff, staffComposing, textVisible, staffScreenFrame]);

  // マイクの今の状態（稼働中/一時停止/OFF）を係員画面へ知らせる。
  // 係員側の入/切ボタンの表示と、「お客様のマイクが切れている」ことの把握に使う。
  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const state = !listening ? "off" : micMuted ? "paused" : "on";
    socketRef.current?.emit("user:micState", { sessionId: sid, state });
  }, [listening, micMuted, sessionId]);

  // 一定時間 合図が来なければ自動で消す。合図を受けるたびに数え直すので、係員が
  // 話している間は点きっぱなしになり、話をやめれば消える。合成中（返事が確実に来る）
  // のときだけは長めに待つ（解除通知が届かなかった場合の保険）。
  useEffect(() => {
    if (!staffComposing) return;
    const ms = composingSynthesizingRef.current ? COMPOSING_MAX_MS : COMPOSING_IDLE_MS;
    const t = setTimeout(() => setStaffComposing(false), ms);
    return () => clearTimeout(t);
  }, [staffComposing, composingSignal]);

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
  /**
   * アバターが今しゃべっているか。**通話が終わったときに、読み上げの途中で画面を
   * 切り替えてしまわないため**に持っている（係員が「ありがとうございました」と言って
   * すぐ終了すると、その音声はまだ再生中で、画面を消すと途中で切れてしまう）。
   */
  const avatarSpeakingRef = useRef(false);
  /**
   * 係員の発言のうち、まだ読み上げ終わっていないものがあるか。
   * **合成には1〜2秒かかるため、「まだ鳴り始めていない」時間帯がある**。そこで終了されると
   * avatarSpeakingRef は false のままなので、この印がないと待たずに切ってしまう。
   * 立てる＝係員の発言が確定したとき／倒す＝読み上げ終了、または音声が出せなかったとき。
   */
  const speechPendingRef = useRef(false);
  /** 読み上げが終わるのを待っている「通話終了」の後始末。終わり次第これを実行する。 */
  const pendingEndRef = useRef<(() => void) | null>(null);
  const notifyAvatarSpeaking = useCallback((speaking: boolean) => {
    if (avatarTailRef.current) { clearTimeout(avatarTailRef.current); avatarTailRef.current = null; }
    avatarSpeakingRef.current = speaking;
    const send = (v: boolean) =>
      socketRef.current?.emit("user:avatarSpeaking", { sessionId: sessionIdRef.current, speaking: v });
    if (speaking) {
      // 鳴り始めたら必ず一時停止（通常は speech:staff 受信時に停止済み。二重の備え）。
      if (STREAMING_STT) setMicMuted(true);
      send(true);
      return;
    }
    // 読み上げが終わった。待たせていた「通話終了」があれば、ここで進める。
    speechPendingRef.current = false;
    const pending = pendingEndRef.current;
    if (pending) { pendingEndRef.current = null; pending(); }
    avatarTailRef.current = setTimeout(() => {
      avatarTailRef.current = null;
      send(false);
      // 常時ON方式: 残響の余韻(AVATAR_TAIL_MS)が過ぎたら聞き取りを自動再開する。
      // 手動OFF中(micOnRef=false)・止める理由が残っている・通話終了処理中は再開しない。
      if (STREAMING_STT && micOnRef.current && !shouldPauseMic() && !pendingEndRef.current) {
        setMicMuted(false);
      }
    }, AVATAR_TAIL_MS);
  }, [setMicMuted, shouldPauseMic]);
  useEffect(() => () => { if (avatarTailRef.current) clearTimeout(avatarTailRef.current); }, []);

  /**
   * アバターが音声を再生できなかったとき（デコード失敗・自動再生のブロック・
   * 端末の音声デバイスの不調など）。サーバーは音声を送れているので、合成側では
   * 検知できない。お客様に音も文字も届かない状態を防ぐため、ここで
   *   ①その発言だけ文字で出す（「文字起こし」がOFFでも出す）
   *   ②係員に知らせる（障害履歴にも残る）
   *   ③**読み上げ待ちの状態を解く**
   * を行う。③が無いと、鳴らないまま「読み上げ中」の印が立ちっぱなしになり、
   * お客様のマイクが自動で戻らず、待たせている「通話終了」も進まない。
   */
  const handlePlaybackError = useCallback(() => {
    const id = lastStaffEntryIdRef.current;
    if (id) setForcedTextIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    const sid = sessionIdRef.current;
    if (sid) socketRef.current?.emit("tts:playbackFailed", { sessionId: sid });
    // 読み上げは行われない。終わったときと同じ後始末をする（マイクの再開・通話終了の続行）。
    notifyAvatarSpeaking(false);
  }, [notifyAvatarSpeaking]);

  const errMsg = ERR[userLang] ?? ERR.ja;
  const ui = UI_TEXT[userLang] ?? UI_TEXT.ja;
  // 言語変更の確認ダイアログは「変更後の言語」で出すため、その言語の設定と文言を先に引く。
  const pendingLangConfig = pendingLang ? SUPPORTED_LANGS.find((l) => l.code === pendingLang) : undefined;
  const pendingUi = pendingLang ? (UI_TEXT[pendingLang] ?? UI_TEXT.ja) : undefined;
  // テキスト非表示のとき、直前のお客様の発言が係員に届いたか（単独表示の判定に使う）。
  const lastEntry = transcript[transcript.length - 1];
  const lastEntryDelivered = lastEntry?.speaker === "user" && deliveredIds.includes(lastEntry.id);
  // マイクのエラーは、お客様が選んだ言語の文章にして出す。
  const micErrText = micError ? (MIC_ERR[userLang] ?? MIC_ERR.ja)[micError] : null;

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

  // --- 未応答タイムアウト（係員は在席だが応答が無いまま打ち切り） ---
  if (phase === "call-timeout") {
    return (
      <div className="min-h-screen bg-blue-900 flex flex-col items-center justify-center gap-6 p-8">
        <div className="w-24 h-24 rounded-full bg-orange-500/20 flex items-center justify-center">
          <span className="text-5xl">⏳</span>
        </div>
        <p className="text-white text-2xl font-bold text-center">{errMsg.busy}</p>
        <p className="text-blue-300 text-base text-center">{errMsg.busySub}</p>
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
              <Flag code={l.code} size={56} />
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
  // 係員が画面共有をしている間は、共有画面を見せることを最優先にレイアウトを組み替える。
  // 右側を広げ、アバターは左側の下（会話の下）へ移す。
  // ★アバターは要素そのものを別の場所に作り直すと読み上げ中の音声が止まる（再生は
  //   Avatar の中で動いているため）ので、置き場所は変えずに CSS だけで動かしている。
  // マイクボタンの見た目は「今この瞬間、声を拾っているか」の1つだけで決める。
  // 止まっている理由（読み上げ中／手動／言語選択中）では見た目を変えない。
  const micLive = listening && !micMuted;
  const sharing = !!staffScreenFrame;
  // 左下のボタン列の下端から数えた高さ＝pb-8(32) + ボタン(76) + mt-6(24)。
  const AVATAR_BOTTOM = 132;
  // ★アバターの高さはドット数で決めない。実機は 1920×1080 の画面を125%に拡大して
  //   表示しており、アプリから見える広さは 1536×864 しかない。ここを固定値(300)に
  //   していたため、狭い画面ではその分がまるごと会話エリアから引かれ、会話が
  //   縦139ドットまで潰れていた（v1.31.0の不具合）。本体の高さに対する割合で決める。
  //   本体の高さ＝画面の高さ − ヘッダー(96) − 見出し(141)。
  const ROW_H = "(100vh - 237px)";
  // 文字起こしONのときは会話に場所を譲る。
  const avatarVisible = `calc(${ROW_H} * ${textVisible ? 0.27 : 0.75})`;
  // 文字起こしONのときは「胸から上」だけを見せる（上から6割を残して下を隠す）。
  // 切り取ったぶん拡大するので、顔の大きさはほとんど変わらない。
  const avatarFull = textVisible ? `calc(${avatarVisible} / 0.6)` : avatarVisible;
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

      {/* 共有中のアバターを画面の座標で置けるように relative にしている。 */}
      <div className="flex-1 flex overflow-hidden relative">
      {/* LEFT: chat + controls */}
      {/* 共有中は左右の余白を詰める。会話の幅が広がるうえ、下の「通話終了／マイク」が
          入りきらず文字が2行に折り返す不具合も解消する（実機1536×864で発生していた）。 */}
      <div
        className={`flex flex-col pt-6 pb-8 overflow-hidden transition-[width] duration-300 ${
          sharing ? "w-[45%] px-10" : "w-[58%] px-28"
        }`}
      >
        {/* Chat bubbles。テキスト表示がOFFのときは会話の文字だけを出さない。
            「係員に伝わりました」「係員が回答を準備しています」は状況を伝える表示
            なので、音声をテキスト化したものではなく、OFFでも残す。 */}
        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
          {transcript.map((entry) => {
            // 音声を届けられなかった発言だけは、非表示の設定でも出す。
            const forced = forcedTextIds.includes(entry.id);
            if (!textVisible && !forced) return null;
            return (
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
                {/* 声が出せなかったことを伝える。無いと「なぜ急に文字だけ？」となる。 */}
                {forced && (
                  <p className="mt-1.5 ml-2 text-lg text-gray-500">{ui.voiceFailed}</p>
                )}
                {/* 係員の画面に届いた合図。待っている間の「伝わったのか」という不安に応える。 */}
                {entry.speaker === "user" && deliveredIds.includes(entry.id) && (
                  <p className="mt-1.5 ml-2 flex items-center gap-1.5 text-lg text-gray-500">
                    <Check size={20} strokeWidth={3} className="text-emerald-600" />
                    {ui.delivered}
                  </p>
                )}
              </div>
            );
          })}

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

        {/* 共有中はここにアバターが立つ。場所だけを空けておき、絵は下の
            アバター本体（位置を CSS で動かしている）が重なる。会話の吹き出しが
            アバターの帽子に触れないよう少しだけ余裕を足す。 */}
        {sharing && <div className="shrink" style={{ height: `calc(${avatarVisible} + 16px)` }} />}

        {/* Bottom controls */}
        <div className="flex items-center gap-4 mt-6 shrink-0">
          <button
            onClick={endCall}
            style={END_CALL_BUTTON}
            className="flex items-center gap-4 py-2.5 pl-2.5 pr-9 active:scale-95 text-white rounded-full text-3xl font-bold shadow-lg ring-[6px] ring-white/80 transition-all shrink-0"
          >
            <span className="flex items-center justify-center w-14 h-14 rounded-full bg-[#991b1b] shrink-0">
              <PhoneOff size={30} strokeWidth={3} className="text-white" />
            </span>
            {ui.endCall}
          </button>

          {/* マイクの状態は3つ: 稼働中（桃色）／読み上げ中の一時停止（琥珀）／手動OFF（灰色）。
              一時停止は「何もしなくても再開される」状態なので、OFFと同じ見た目にしない。 */}
          <button
            onClick={toggleMic}
            style={micLive ? MIC_BUTTON_ON : MIC_BUTTON_OFF}
            className={`flex-1 flex items-center gap-4 py-2.5 pl-2.5 pr-9 active:scale-95 rounded-full shadow-lg ring-[6px] ring-white/80 transition-all text-left ${
              micLive ? "text-[#a3306a]" : "text-white"
            }`}
          >
            <div
              className={`w-14 h-14 rounded-full flex items-center justify-center shrink-0 relative transition-colors ${
                micLive ? "bg-[#ec4899] mic-live-dot" : "bg-white"
              }`}
            >
              {/* 聞き取り中は、外へ広がる波を2枚ずらして出す（遠目にも動きが分かるように）。 */}
              {micLive && (
                <>
                  <span className="mic-live-wave absolute inline-flex h-full w-full rounded-full bg-pink-400" />
                  <span className="mic-live-wave mic-live-wave-delayed absolute inline-flex h-full w-full rounded-full bg-pink-400" />
                </>
              )}
              <Mic
                size={30}
                strokeWidth={3}
                className={`relative z-10 ${micLive ? "text-white" : "text-gray-900"}`}
              />
            </div>
            {/* 状態名を1行目、補足を2行目に置く。横に並べると画面が狭いとき
                「お話しく／ださい」のように語の途中で折り返してしまうため。
                2行あわせて丸アイコン(56px)より低くしてあるので、どの状態でも
                ボタンの高さは変わらない。 */}
            <div className="flex-1 overflow-hidden">
              {micLive ? (
                <p className="leading-none">
                  <span className="block text-3xl leading-none font-bold">{ui.micOn}</span>
                  {/* 認識中の文字が出ているときは、そちらを読ませたいので案内文は引っ込める。 */}
                  <span className="block mt-1 text-base leading-none text-gray-700 truncate">
                    {textVisible && interimUser ? interimUser : ui.micOnNote}
                  </span>
                </p>
              ) : micError ? (
                <p className="text-base text-red-300">{micErrText}</p>
              ) : (
                <p className="text-3xl font-bold">{ui.micOff}</p>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* RIGHT: Screen share (when active) + Avatar */}
      <div className={`flex flex-col transition-[width] duration-300 ${sharing ? "w-[55%]" : "w-[42%]"}`}>
        {staffScreenFrame && (
          // 共有中はこの列をほぼ全部使う。画像は必ず横長（16:9）で届くので、
          // aspect-video にすると上下に黒帯が出ずぴったり収まる。
          <div className="p-4 pb-2 flex-1 min-h-0 flex items-center justify-center">
            <ScreenShareView
              frameData={staffScreenFrame}
              label="スタッフ画面"
              className="w-full aspect-video max-h-full rounded-xl overflow-hidden border-2 border-sky-400"
            />
          </div>
        )}
        {/* アバター本体。共有中は左側の下へ移す（要素は作り直さない＝読み上げが途切れない）。
            w-[45%] は左の列と同じ幅＝上の列の指定と対で変えること。maxHeight は画面が
            短いとき（開発用に小さい窓で開いたとき等）に頭が切れないための保険。 */}
        <div
          className={
            sharing
              ? "absolute left-0 w-[45%] flex items-start justify-center overflow-hidden pointer-events-none"
              : "flex-1 min-h-0 flex items-end justify-center pb-2"
          }
          style={
            sharing
              ? { bottom: AVATAR_BOTTOM, height: avatarVisible, maxHeight: `calc(100% - ${AVATAR_BOTTOM + 24}px)` }
              : undefined
          }
        >
          {/* 内側の入れ物。外より背を高くして上端で揃えると、下（お腹から下）が
              隠れて「胸から上」になる。この入れ物は共有していないときも必ず置く
              ——アバターを別の場所に作り直すと読み上げ中の音声が止まるため。 */}
          <div className={sharing ? "shrink-0" : "h-full"} style={sharing ? { height: avatarFull } : undefined}>
            <Avatar
              audioQueueRef={audioQueueRef}
              audioTick={audioTick}
              moreAudioComing={moreAudioComing}
              onSpeakingChange={notifyAvatarSpeaking}
              onPlaybackError={handlePlaybackError}
              visible
              size="xl"
            />
          </div>
        </div>

        {/* アバターの下の設定ボタン。左＝会話のテキスト表示ON/OFF、右＝言語の選び直し。
            言語のほうはマイクON中は認識中の音声を取りこぼすため変更させず、押されたら
            理由を説明する（無反応にすると壊れていると思われるため）。 */}
        <div className="shrink-0 flex justify-center items-center gap-4 pb-8">
          {/* スイッチの見た目にしている。灰色の状態表示だと「押せない」「使えない」と
              受け取られ、文字を出したいお客様がたどり着けなかったため。物理スイッチの
              形は言語を問わず通じ、「今の状態」と「押せること」が同時に伝わる。 */}
          <button
            onClick={toggleTextVisible}
            className={`flex items-center gap-4 py-2 pl-2 pr-6 rounded-full bg-white border-2 shadow-lg ring-[6px] ring-white/80 active:scale-95 transition-all ${
              textVisible ? "border-sky-500 hover:bg-sky-50" : "border-[#8b5cf6] hover:bg-violet-50"
            }`}
          >
            {/* アイコンは常に「文字が入った吹き出し」。OFF時にバツ印にすると機能が
                使えないように見えるため、色だけで状態を示す。 */}
            <span
              className={`w-14 h-14 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                textVisible ? "bg-sky-500" : "bg-[#8b5cf6]"
              }`}
            >
              <MessageSquareText size={30} strokeWidth={2.5} className="text-white" />
            </span>
            <span className="flex flex-col items-start gap-1">
              <span className="text-xl font-bold text-gray-700 leading-none">{ui.textLabel}</span>
              <span className="flex items-center gap-2">
                {/* スイッチ本体 */}
                <span
                  className={`w-14 h-8 rounded-full flex items-center px-1 transition-colors ${
                    textVisible ? "bg-sky-500 justify-end" : "bg-gray-300 justify-start"
                  }`}
                >
                  <span className="w-6 h-6 rounded-full bg-white shadow" />
                </span>
                <span className={`text-lg font-bold leading-none ${textVisible ? "text-sky-700" : "text-gray-500"}`}>
                  {textVisible ? "ON" : "OFF"}
                </span>
              </span>
            </span>
          </button>

          {/* 言語の選び直し。開いている間はマイクを自動で止め、閉じたら元に戻すので、
              マイクの状態にかかわらずいつでも押せる。 */}
          <button
            onClick={openLangPanel}
            className="flex items-center gap-3 bg-white py-2 pl-2 pr-7 rounded-full shadow-lg ring-[6px] ring-white/80 active:scale-95 transition-all hover:bg-gray-50"
          >
            <span className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center shrink-0">
              {langConfig && <Flag code={langConfig.code} size={40} />}
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
            {pendingLang && pendingLangConfig && pendingUi ? (
              <>
                <div className="flex flex-col items-center gap-3">
                  <Flag code={pendingLangConfig.code} size={104} />
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
                      <Flag code={l.code} size={68} />
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
