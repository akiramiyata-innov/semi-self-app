import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache, findGlossaryConflict } from "@/lib/glossaryClient";
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

    const withJa = incoming.filter((row) => row.ja?.trim());
    // よみは必須（画面の追加フォームと同じ扱い）。未入力の行は登録せず、件数を返して知らせる。
    const noYomi = withJa.filter((row) => !row.yomi?.trim());
    // 同じ言葉（日本語・外国語とも）の二重登録は拒否（2026-08-17 ユーザー決定）。
    // 既存との重複だけでなく、**取り込みファイルの中どうしの重複**もここで弾く
    // （受け入れた行を検査対象に足しながら進めるため、ファイル内の2行目以降が引っかかる）。
    const accepted: GlossaryTerm[] = [...existing];
    const newTerms: GlossaryTerm[] = [];
    for (const row of withJa) {
      if (!row.yomi?.trim()) continue;
      if (findGlossaryConflict(accepted, row)) continue;
      const term: GlossaryTerm = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
        ja: row.ja!.trim(),
        yomi: row.yomi!.trim(),
        en: row.en?.trim() || undefined,
        zh: row.zh?.trim() || undefined,
        "zh-TW": row["zh-TW"]?.trim() || undefined,
        ko: row.ko?.trim() || undefined,
        fr: row.fr?.trim() || undefined,
        es: row.es?.trim() || undefined,
        th: row.th?.trim() || undefined,
      };
      accepted.push(term);
      newTerms.push(term);
    }

    await saveGlossaryTerms([...existing, ...newTerms]);
    invalidateGlossaryCache();
    return NextResponse.json({
      added: newTerms.length,
      duplicated: withJa.length - noYomi.length - newTerms.length,
      noYomi: noYomi.length,
      noYomiSamples: noYomi.slice(0, 5).map((row) => row.ja!.trim()),
    });
  } catch {
    return NextResponse.json({ error: "インポートに失敗しました" }, { status: 500 });
  }
}
