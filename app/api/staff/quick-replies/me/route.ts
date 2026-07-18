import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getQuickReplies, setQuickReplies } from "@/lib/quickReplyClient";

// 定型文の上限（暴発防止）。1件あたりの長さは TTS の一文制限に十分収まる範囲。
const MAX_PHRASES = 30;
const MAX_LEN = 200;

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const phrases = await getQuickReplies(session.uid);
  return NextResponse.json({ phrases });
}

export async function PUT(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null) as { phrases?: unknown } | null;
  if (!body || !Array.isArray(body.phrases)) {
    return NextResponse.json({ error: "phrases must be an array" }, { status: 400 });
  }

  // 文字列のみ・前後空白除去・空文字と長すぎる文を除外・重複排除・件数上限。
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const p of body.phrases) {
    if (typeof p !== "string") continue;
    const t = p.trim().slice(0, MAX_LEN);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    phrases.push(t);
    if (phrases.length >= MAX_PHRASES) break;
  }

  await setQuickReplies(session.uid, phrases);
  return NextResponse.json({ ok: true, phrases });
}
