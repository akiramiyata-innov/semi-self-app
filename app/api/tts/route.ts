import { NextRequest, NextResponse } from "next/server";
import { getLang } from "@/lib/languages";
import type { LangCode } from "@/lib/socketEvents";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

export async function POST(req: NextRequest) {
  const { text, lang } = await req.json() as { text: string; lang: LangCode };
  if (!text || !lang) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }

  const langConfig = getLang(lang);
  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: langConfig.bcp47, name: langConfig.ttsVoice },
      audioConfig: { audioEncoding: "MP3" },
    }),
  });
  const json = await res.json() as { audioContent?: string; error?: unknown };
  if (json.error) {
    return NextResponse.json({ error: json.error }, { status: 500 });
  }
  return NextResponse.json({ audioBase64: json.audioContent ?? "" });
}
