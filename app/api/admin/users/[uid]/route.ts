import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { uid } = await params;
  await adminAuth.deleteUser(uid);
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { uid } = await params;
  const body = await req.json();
  await adminAuth.updateUser(uid, body);
  return NextResponse.json({ ok: true });
}
