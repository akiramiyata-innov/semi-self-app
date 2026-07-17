import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache } from "@/lib/glossaryClient";
import type { GlossaryTerm } from "@/lib/types";

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const { terms: incoming } = await req.json() as { terms: Partial<GlossaryTerm>[] };
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return NextResponse.json({ error: "用語データが空です" }, { status: 400 });
    }

    const existing = await getGlossaryTerms();
    const existingJa = new Set(existing.map((t) => t.ja));

    const newTerms: GlossaryTerm[] = incoming
      .filter((row) => row.ja?.trim())
      .filter((row) => !existingJa.has(row.ja!.trim()))
      .map((row) => ({
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        ja: row.ja!.trim(),
        yomi: row.yomi?.trim() || undefined,
        en: row.en?.trim() || undefined,
        zh: row.zh?.trim() || undefined,
        "zh-TW": row["zh-TW"]?.trim() || undefined,
        ko: row.ko?.trim() || undefined,
        fr: row.fr?.trim() || undefined,
        es: row.es?.trim() || undefined,
        th: row.th?.trim() || undefined,
      }));

    await saveGlossaryTerms([...existing, ...newTerms]);
    invalidateGlossaryCache();
    return NextResponse.json({ added: newTerms.length, skipped: incoming.length - newTerms.length });
  } catch {
    return NextResponse.json({ error: "インポートに失敗しました" }, { status: 500 });
  }
}
