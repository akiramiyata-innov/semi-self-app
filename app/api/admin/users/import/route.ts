import { NextRequest, NextResponse } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
}

interface StaffRow {
  displayName?: string;
  email?: string;
  password?: string;
  isManager?: boolean;
}

function normalize(row: Record<string, string>): StaffRow {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k]?.toString().trim();
      if (v) return v;
    }
    return undefined;
  };
  const managerRaw = get("マネージャー", "isManager", "manager", "Manager");
  return {
    displayName: get("名前", "displayName", "name", "Name", "氏名"),
    email: get("メール", "email", "Email", "メールアドレス"),
    password: get("パスワード", "password", "Password", "仮パスワード"),
    isManager: managerRaw === "true" || managerRaw === "1" || managerRaw === "○" || managerRaw === "yes",
  };
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { rows } = await req.json() as { rows: Record<string, string>[] };
  const results: { email: string; status: "created" | "skipped" | "error"; reason?: string }[] = [];

  for (const raw of rows) {
    const row = normalize(raw);
    if (!row.email || !row.displayName || !row.password) {
      results.push({ email: row.email ?? "(不明)", status: "skipped", reason: "必須項目が不足" });
      continue;
    }
    try {
      const user = await adminAuth.createUser({
        displayName: row.displayName,
        email: row.email,
        password: row.password,
      });
      if (row.isManager) {
        await adminAuth.setCustomUserClaims(user.uid, { isManager: true });
      }
      results.push({ email: row.email, status: "created" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "エラー";
      results.push({ email: row.email, status: "error", reason: msg });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  return NextResponse.json({ created, results });
}
