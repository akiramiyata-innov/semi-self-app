import { NextRequest, NextResponse } from "next/server";

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";

export async function POST(req: NextRequest) {
  const { text, from, to } = await req.json() as { text: string; from: string; to: string };
  if (!text || !from || !to) {
    return NextResponse.json({ error: "Missing params" }, { status: 400 });
  }
  if (from === to) {
    return NextResponse.json({ translatedText: text });
  }

  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, source: from, target: to, format: "text" }),
  });
  const json = await res.json() as { data?: { translations?: Array<{ translatedText: string }> } };
  const translatedText = json.data?.translations?.[0]?.translatedText ?? text;
  return NextResponse.json({ translatedText });
}
