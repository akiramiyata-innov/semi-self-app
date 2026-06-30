import { NextRequest, NextResponse } from "next/server";
import { getGlossaryTerms } from "@/lib/glossaryClient";

export async function POST(req: NextRequest) {
  const { audio, lang } = await req.json() as { audio: string; lang: string };

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("[STT] GOOGLE_API_KEY が未設定");
    return NextResponse.json({ transcript: "" }, { status: 500 });
  }

  const terms = await getGlossaryTerms();
  const phrases = terms.map((t) => t.ja).filter(Boolean);

  const res = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          encoding: "WEBM_OPUS",
          languageCode: lang || "ja-JP",
          enableAutomaticPunctuation: true,
          ...(phrases.length > 0 && {
            speechContexts: [{ phrases, boost: 15 }],
          }),
        },
        audio: { content: audio },
      }),
    }
  );

  const json = await res.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    error?: { message: string; code?: number };
  };

  if (json.error) {
    console.error("[STT] APIエラー:", json.error.message);
    return NextResponse.json({ transcript: "", error: json.error.message }, { status: 500 });
  }

  // 複数 results を結合（長い発話は複数に分割される）
  const transcript = json.results
    ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
    .join("") ?? "";
  return NextResponse.json({ transcript });
}
