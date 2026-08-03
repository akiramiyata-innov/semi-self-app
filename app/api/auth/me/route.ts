import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  // セッションが無い/無効/期限切れは 401 で返す。以前は常に 200（中身 null）を
  // 返していたため、スタッフ画面の5分ごとのセッション切れ確認（401 のときだけ
  // 「再ログインしてください」を出す）が一度も発動しなかった（v1.1.0からの不具合）。
  // 画面起動時の利用側は中身の null 判定なので 401 でも従来どおり動く。
  if (!token) return NextResponse.json(null, { status: 401 });
  const session = await verifySessionToken(token);
  if (!session) return NextResponse.json(null, { status: 401 });
  return NextResponse.json(session);
}
