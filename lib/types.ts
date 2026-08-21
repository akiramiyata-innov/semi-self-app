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
  /**
   * 話し始めの時刻（v1.52.0）。画面と記録はこの順に並べる（lib/transcriptOrder.ts）。
   * 確定の順に並べると、確定に時間のかかるお客様の発言が係員の返事の後ろに回るため。
   * 認識エンジンが言葉を聞き取り始めた時刻（最初の途中経過）をサーバーが付ける。
   * 無い古い記録・テキスト送信は timestamp（届いた時刻）で代用する。
   */
  spokeAt?: number;
  /**
   * 係員の返答が、並びで直前にあるお客様の発言の**確定より前**に行われた印（v1.52.0）。
   * お客様の発言が後から上に差し込まれたとき、その直後の係員の返答に付く。
   * 係員が「その発言を見ずに答えた可能性」に気づくためのもの。
   */
  earlyReply?: boolean;
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
  /** 通話時に動いていたアプリの版（例: "v1.41.0"）。 */
  appVersion?: string;
}

export interface SessionSummary {
  sessionId: string;
  machineName: string;
  userLang: string;
  startedAt: number;
  durationSeconds: number;
  messageCount: number;
}

/**
 * 障害履歴の1件。トースト通知（4秒で消える）やサーバーログ（管理画面から見えない）
 * にしか残らなかった異常を、管理画面 /admin/errors で後から確認できるようにする。
 */
export interface AppErrorEntry {
  /** 発生時刻（エポックms） */
  at: number;
  /** 種類（translate / tts-synthesis / tts-playback / logsave / mic-user / mic-staff / call-timeout / disconnect / stt-guard-* / stt-stream） */
  type: string;
  sessionId?: string;
  machineName?: string;
  /** 対応していた係員の名前（分かる場合）。「誰が対応中に起きたか」を後から追うため。 */
  staffName?: string;
  /**
   * 発生元がお客様側か係員側か。**音声認識まわりの記録で特に重要**で、
   * 認識ガードは係員の発話でも作動するため、これが無いとどちらの声か分からない。
   */
  side?: "user" | "staff";
  /** 人が読む詳細（エラー内容・しきい値・対象テキストなど） */
  detail?: string;
  /** 発生時に動いていたアプリの版（例: "v1.41.0"）。修正済みの版かを即断するため。 */
  version?: string;
}
