import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getAppErrorsFresh } from "@/lib/errorLogClient";

// 障害履歴の取得（管理者のみ）。書き込みは Socket.IO サーバー側の recordAppError が
// 行うため、この API は読み取り専用。新しい順に返す。
export async function GET(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const errors = await getAppErrorsFresh();
  return NextResponse.json({ errors: [...errors].sort((a, b) => b.at - a.at) });
}
