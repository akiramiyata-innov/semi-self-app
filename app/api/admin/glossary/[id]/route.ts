import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache, findGlossaryConflict, glossaryConflictMessage } from "@/lib/glossaryClient";
import type { GlossaryTerm } from "@/lib/types";

/**
 * 用語の編集（v1.54.0）。これまでは「削除して追加し直す」しかなく、訳語を1つ直すにも
 * 全欄を打ち直す必要があった。id と並び順はそのまま、中身だけを差し替える。
 * 必須項目・二重登録の検査は追加（POST）と同じ。二重登録の検査からは自分自身を除く。
 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const body = await req.json() as Partial<GlossaryTerm>;
    if (!body.ja?.trim()) {
      return NextResponse.json({ error: "日本語は必須です" }, { status: 400 });
    }
    if (!body.yomi?.trim()) {
      return NextResponse.json({ error: "よみは必須です（ひらがなで入力してください）" }, { status: 400 });
    }
    const terms = await getGlossaryTerms();
    const idx = terms.findIndex((t) => t.id === id);
    if (idx < 0) {
      return NextResponse.json({ error: "該当する用語が見つかりません（すでに削除されている可能性があります）" }, { status: 404 });
    }
    const conflict = findGlossaryConflict(terms.filter((t) => t.id !== id), body);
    if (conflict) {
      return NextResponse.json({ error: glossaryConflictMessage(conflict) }, { status: 400 });
    }
    const updated: GlossaryTerm = {
      id,
      ja: body.ja.trim(),
      yomi: body.yomi.trim(),
      en: body.en?.trim() || undefined,
      zh: body.zh?.trim() || undefined,
      "zh-TW": body["zh-TW"]?.trim() || undefined,
      ko: body.ko?.trim() || undefined,
      fr: body.fr?.trim() || undefined,
      es: body.es?.trim() || undefined,
      th: body.th?.trim() || undefined,
    };
    const next = terms.slice();
    next[idx] = updated; // 並び順は変えない
    await saveGlossaryTerms(next);
    invalidateGlossaryCache();
    return NextResponse.json({ term: updated });
  } catch {
    return NextResponse.json({ error: "更新に失敗しました" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const terms = await getGlossaryTerms();
  const updated = terms.filter((t) => t.id !== id);
  await saveGlossaryTerms(updated);
  invalidateGlossaryCache();
  return NextResponse.json({ ok: true });
}
