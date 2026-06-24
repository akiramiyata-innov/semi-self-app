import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { audio, lang } = await req.json() as { audio: string; lang: string };

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return NextResponse.json({ transcript: "" }, { status: 500 });

  const res = await fetch(
    `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          encoding: "WEBM_OPUS",
          languageCode: lang || "ja-JP",
          model: "latest_short",
          enableAutomaticPunctuation: true,
        },
        audio: { content: audio },
      }),
    }
  );

  const json = await res.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    error?: { message: string };
  };

  if (json.error) {
    console.error("[STT API]", json.error.message);
    return NextResponse.json({ transcript: "" }, { status: 500 });
  }

  const transcript = json.results?.[0]?.alternatives?.[0]?.transcript ?? "";
  return NextResponse.json({ transcript });
}
