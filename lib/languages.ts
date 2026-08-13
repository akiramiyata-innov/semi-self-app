import type { LangCode } from "./socketEvents";

// TTS voices: all languages use Google's newest Chirp3-HD generation with the
// same female persona ("Achernar") so the station attendant sounds like one
// consistent person across languages. Traditional Chinese (cmn-TW) has no
// Chirp3-HD voice yet, so it uses the female Wavenet-A (Wavenet-C was male —
// a mismatch with the female avatar).
// 国旗は絵文字ではなく public/flags/*.svg の画像で表示する（components/Flag.tsx）。
// **Windows の標準の絵文字フォントには国旗が入っておらず「JP」「US」等の2文字になる**ため、
// ここに絵文字を持たせない（持たせると、また表示に使われてしまう）。
export const SUPPORTED_LANGS = [
  { code: "ja" as LangCode, bcp47: "ja-JP", label: "日本語", ttsVoice: "ja-JP-Chirp3-HD-Achernar" },
  { code: "en" as LangCode, bcp47: "en-US", label: "English", ttsVoice: "en-US-Chirp3-HD-Achernar" },
  { code: "zh" as LangCode, bcp47: "zh-CN", label: "中文（简体）", ttsVoice: "cmn-CN-Chirp3-HD-Achernar" },
  { code: "zh-TW" as LangCode, bcp47: "zh-TW", label: "中文（繁体）", ttsVoice: "cmn-TW-Wavenet-A" },
  { code: "ko" as LangCode, bcp47: "ko-KR", label: "한국어", ttsVoice: "ko-KR-Chirp3-HD-Achernar" },
  { code: "fr" as LangCode, bcp47: "fr-FR", label: "Français", ttsVoice: "fr-FR-Chirp3-HD-Achernar" },
  { code: "es" as LangCode, bcp47: "es-ES", label: "Español", ttsVoice: "es-ES-Chirp3-HD-Achernar" },
  { code: "th" as LangCode, bcp47: "th-TH", label: "ภาษาไทย", ttsVoice: "th-TH-Chirp3-HD-Achernar" },
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

export function getLang(code: LangCode): SupportedLang {
  return SUPPORTED_LANGS.find((l) => l.code === code) ?? SUPPORTED_LANGS[0];
}

export function getGoogleTranslateLangCode(code: LangCode): string {
  const map: Record<LangCode, string> = {
    ja: "ja",
    en: "en",
    zh: "zh-CN",
    "zh-TW": "zh-TW",
    ko: "ko",
    fr: "fr",
    es: "es",
    th: "th",
  };
  return map[code];
}
