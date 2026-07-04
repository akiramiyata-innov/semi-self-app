export interface Station {
  id: string;
  name: string;
  code?: string;
}

export interface GlossaryTerm {
  id: string;
  ja: string;
  en?: string;
  zh?: string;
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
}

export interface SessionSummary {
  sessionId: string;
  machineName: string;
  userLang: string;
  startedAt: number;
  durationSeconds: number;
  messageCount: number;
}
