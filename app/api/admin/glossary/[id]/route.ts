import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { getGlossaryTerms, saveGlossaryTerms, invalidateGlossaryCache } from "@/lib/glossaryClient";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
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
