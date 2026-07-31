export interface Station {
  id: string;
  name: string;
  code?: string;
}

export interface GlossaryTerm {
  id: string;
  ja: string;
  /**
   * 読み（ひらがな）。任意。chirp_2 が漢字化できず読み（カナ）で出してしまう語
   * （例：舎人→トネリ）を、認識後に漢字へ戻す後処理に使う。
   */
  yomi?: string;
  en?: string;
  zh?: string;
  "zh-TW"?: string;
  ko?: string;
  fr?: string;
  es?: string;
  th?: string;
}

export interface TranscriptEntry {
  id: string;
  speaker: "user" | "staff";
  text: string;
  translatedText?: string;
  isFinal: boolean;
  timestamp: number;
  /** 翻訳に失敗した発言（係員画面に印を残し、トーストを見逃しても分かるようにする）。 */
  translationFailed?: boolean;
  /** 音声をお客様に届けられなかった発言（合成失敗・お客様の端末での再生失敗）。 */
  voiceFailed?: boolean;
}

/** 性能検証テスト用の自動測定値（server/metrics.ts が記録）。単位はミリ秒。 */
export interface SessionMetrics {
  callAnswerDelayMs?: number;
  sttFinalDelaysMs: number[];
  ttsDelaysMs: number[];
  disconnects: number;
}

export interface SessionLog {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  transcript: TranscriptEntry[];
  /** 自動測定値。性能検証で使用（通常運用では参照されない）。 */
  metrics?: SessionMetrics;
}

export interface SessionSummary {
  sessionId: string;
  machineName: string;
  userLang: string;
  startedAt: number;
  durationSeconds: number;
  messageCount: number;
}
