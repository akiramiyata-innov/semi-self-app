import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { requireAdmin } from "@/lib/session";

export async function GET(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await adminAuth.listUsers();
  const adminEmails = (process.env.FIREBASE_ADMIN_EMAILS ?? "")
    .split(",").map((e) => e.trim()).filter(Boolean);
  const users = result.users.map((u) => ({
    uid: u.uid,
    email: u.email ?? "",
    displayName: u.displayName ?? "",
    creationTime: u.metadata.creationTime,
    isAdmin: adminEmails.includes(u.email ?? ""),
    isManager: !!(u.customClaims?.isManager),
  }));

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const { displayName, email, password, isManager } = await req.json();
    const user = await adminAuth.createUser({ displayName, email, password });
    if (isManager) {
      await adminAuth.setCustomUserClaims(user.uid, { isManager: true });
    }
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "作成に失敗しました";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
