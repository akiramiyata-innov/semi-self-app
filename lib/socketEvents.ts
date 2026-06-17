export type LangCode = "ja" | "en" | "zh" | "ko" | "fr" | "es" | "th";

// Staff presence
export type StaffStatus = "available" | "busy" | "away";

export interface StaffInfo {
  socketId: string;
  name: string;
  status: StaffStatus;
  activeCalls: number;
}

// Call lifecycle
export interface CallRequestPayload {
  machineId: string;
  machineName: string;
}

export interface CallIncomingPayload {
  sessionId: string;
  machineId: string;
  machineName: string;
  timestamp: number;
}

export interface CallAnsweredPayload {
  sessionId: string;
  staffName: string;
}

export interface CallTakenPayload {
  sessionId: string;
}

export interface CallEndPayload {
  sessionId: string;
}

// Speech events
export interface SpeechUserPayload {
  sessionId: string;
  text: string;
  lang: LangCode;
  isFinal: boolean;
  translatedText?: string; // Japanese translation, server-added
}

export interface SpeechStaffPayload {
  sessionId: string;
  text: string; // Japanese (original)
  isFinal: boolean;
  translatedText?: string; // User's language translation, server-added
}

// TTS audio from server to user
export interface TtsAudioPayload {
  sessionId: string;
  audioBase64: string;
  lang: LangCode;
}

// Screen share / camera frames
export interface ScreenFramePayload {
  sessionId: string;
  frameData: string; // base64 JPEG
}

// Language update
export interface SessionSetLangPayload {
  sessionId: string;
  lang: LangCode;
}

// Server → Staff events map
export interface ServerToStaffEvents {
  "call:incoming": (payload: CallIncomingPayload) => void;
  "call:taken": (payload: CallTakenPayload) => void;
  "call:ended": (payload: CallEndPayload) => void;
  "speech:user": (payload: SpeechUserPayload) => void;
  "screen:frame": (payload: ScreenFramePayload) => void;
}

// Server → User events map
export interface ServerToUserEvents {
  "call:answered": (payload: CallAnsweredPayload) => void;
  "call:ended": (payload: CallEndPayload) => void;
  "speech:staff": (payload: SpeechStaffPayload) => void;
  "tts:audio": (payload: TtsAudioPayload) => void;
  "screen:share": (payload: ScreenFramePayload) => void;
}
