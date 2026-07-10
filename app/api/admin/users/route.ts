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
  const users = result.users.map((u) => {
    // isSuperAdmin: 環境変数で設定された固定管理者（画面からは変更不可の非常用）
    // isAdminClaim: 画面トグルで付与できる Firebase 権限フラグ
    const isSuperAdmin = adminEmails.includes(u.email ?? "");
    const isAdminClaim = !!(u.customClaims?.isAdmin);
    return {
      uid: u.uid,
      email: u.email ?? "",
      displayName: u.displayName ?? "",
      creationTime: u.metadata.creationTime,
      isAdmin: isSuperAdmin || isAdminClaim,
      isSuperAdmin,
    };
  });

  // 登録が新しい順（新→旧）で並べる
  users.sort((a, b) => (Date.parse(b.creationTime) || 0) - (Date.parse(a.creationTime) || 0));

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const { displayName, email, password } = await req.json();
    await adminAuth.createUser({ displayName, email, password });
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "作成に失敗しました";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
