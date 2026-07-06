import type { LangCode } from "./socketEvents";

export const SUPPORTED_LANGS = [
  { code: "ja" as LangCode, bcp47: "ja-JP", label: "日本語", flag: "🇯🇵", ttsVoice: "ja-JP-Neural2-B" },
  { code: "en" as LangCode, bcp47: "en-US", label: "English", flag: "🇺🇸", ttsVoice: "en-US-Neural2-F" },
  { code: "zh" as LangCode, bcp47: "zh-CN", label: "中文（简体）", flag: "🇨🇳", ttsVoice: "cmn-CN-Wavenet-C" },
  { code: "zh-TW" as LangCode, bcp47: "zh-TW", label: "中文（繁体）", flag: "🇹🇼", ttsVoice: "cmn-TW-Wavenet-C" },
  { code: "ko" as LangCode, bcp47: "ko-KR", label: "한국어", flag: "🇰🇷", ttsVoice: "ko-KR-Neural2-B" },
  { code: "fr" as LangCode, bcp47: "fr-FR", label: "Français", flag: "🇫🇷", ttsVoice: "fr-FR-Neural2-C" },
  { code: "es" as LangCode, bcp47: "es-ES", label: "Español", flag: "🇪🇸", ttsVoice: "es-ES-Neural2-B" },
  { code: "th" as LangCode, bcp47: "th-TH", label: "ภาษาไทย", flag: "🇹🇭", ttsVoice: "th-TH-Neural2-C" },
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
