import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache } from "@/lib/glossaryClient";
import type { GlossaryTerm } from "@/lib/types";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
}

export async function GET(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const terms = await getGlossaryTerms();
  return NextResponse.json({ terms });
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json() as Partial<GlossaryTerm>;
    if (!body.ja?.trim()) {
      return NextResponse.json({ error: "日本語は必須です" }, { status: 400 });
    }
    const terms = await getGlossaryTerms();
    const newTerm: GlossaryTerm = {
      id: Date.now().toString(),
      ja: body.ja.trim(),
      en: body.en?.trim() || undefined,
      zh: body.zh?.trim() || undefined,
      ko: body.ko?.trim() || undefined,
      fr: body.fr?.trim() || undefined,
      es: body.es?.trim() || undefined,
      th: body.th?.trim() || undefined,
    };
    await saveGlossaryTerms([...terms, newTerm]);
    invalidateGlossaryCache();
    return NextResponse.json({ term: newTerm });
  } catch {
    return NextResponse.json({ error: "追加に失敗しました" }, { status: 500 });
  }
}
