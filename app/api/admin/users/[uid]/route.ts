import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { requireAdmin } from "@/lib/session";
import type { UpdateRequest } from "firebase-admin/auth";

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
  const body = await req.json() as { isAdmin?: boolean; password?: string; displayName?: string };

  if (typeof body.isAdmin === "boolean") {
    const user = await adminAuth.getUser(uid);
    const existing = user.customClaims ?? {};
    await adminAuth.setCustomUserClaims(uid, { ...existing, isAdmin: body.isAdmin });
  } else {
    const update: UpdateRequest = {};
    if (body.password) update.password = body.password;
    if (body.displayName) update.displayName = body.displayName;
    if (Object.keys(update).length > 0) await adminAuth.updateUser(uid, update);
  }

  return NextResponse.json({ ok: true });
}
