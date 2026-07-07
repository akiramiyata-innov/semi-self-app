import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache } from "@/lib/glossaryClient";

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
