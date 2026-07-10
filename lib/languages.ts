import type { LangCode } from "./socketEvents";

// TTS voices: all languages use Google's newest Chirp3-HD generation with the
// same female persona ("Aoede", warm/friendly) so the station attendant sounds
// like one consistent person across languages. Traditional Chinese (cmn-TW) has
// no Chirp3-HD voice yet, so it uses the female Wavenet-A (Wavenet-C was male —
// a mismatch with the female avatar).
export const SUPPORTED_LANGS = [
  { code: "ja" as LangCode, bcp47: "ja-JP", label: "日本語", flag: "🇯🇵", ttsVoice: "ja-JP-Chirp3-HD-Aoede" },
  { code: "en" as LangCode, bcp47: "en-US", label: "English", flag: "🇺🇸", ttsVoice: "en-US-Chirp3-HD-Aoede" },
  { code: "zh" as LangCode, bcp47: "zh-CN", label: "中文（简体）", flag: "🇨🇳", ttsVoice: "cmn-CN-Chirp3-HD-Aoede" },
  { code: "zh-TW" as LangCode, bcp47: "zh-TW", label: "中文（繁体）", flag: "🇹🇼", ttsVoice: "cmn-TW-Wavenet-A" },
  { code: "ko" as LangCode, bcp47: "ko-KR", label: "한국어", flag: "🇰🇷", ttsVoice: "ko-KR-Chirp3-HD-Aoede" },
  { code: "fr" as LangCode, bcp47: "fr-FR", label: "Français", flag: "🇫🇷", ttsVoice: "fr-FR-Chirp3-HD-Aoede" },
  { code: "es" as LangCode, bcp47: "es-ES", label: "Español", flag: "🇪🇸", ttsVoice: "es-ES-Chirp3-HD-Aoede" },
  { code: "th" as LangCode, bcp47: "th-TH", label: "ภาษาไทย", flag: "🇹🇭", ttsVoice: "th-TH-Chirp3-HD-Aoede" },
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
