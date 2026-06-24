import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { audio, lang } = await req.json() as { audio: string; lang: string };

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("[STT] GOOGLE_API_KEY が未設定");
    return NextResponse.json({ transcript: "" }, { status: 500 });
  }

  console.log(`[STT] 受信 lang=${lang} audio=${audio.length} chars`);

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
        },
        audio: { content: audio },
      }),
    }
  );

  const json = await res.json() as {
    results?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    error?: { message: string; code?: number };
  };

  console.log("[STT] Google応答:", JSON.stringify(json).slice(0, 300));

  if (json.error) {
    console.error("[STT] APIエラー:", json.error.message);
    return NextResponse.json({ transcript: "", error: json.error.message }, { status: 500 });
  }

  const transcript = json.results?.[0]?.alternatives?.[0]?.transcript ?? "";
  console.log(`[STT] 結果: "${transcript}"`);
  return NextResponse.json({ transcript });
}
