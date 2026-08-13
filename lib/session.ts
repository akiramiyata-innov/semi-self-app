import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export interface SessionPayload {
  uid: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export const SESSION_COOKIE_NAME = "staff-session";

/**
 * ログイン状態の持ち方。
 *
 * ★maxAge / expires を**あえて付けない**（2026-08-13）。付けないとブラウザを閉じた
 * 時点で消える「セッションクッキー」になり、**次に開いたときは必ずログインから**始まる。
 * 遠隔操作端末は交代で使うため、7日保持のままだと**前の担当者のログイン状態を次の人が
 * そのまま引き継いでしまう**（誰の操作か分からなくなる）。それを断つための変更。
 *
 * 期限そのものは createSessionToken 側で 12 時間にしている（閉じ忘れへの備え）。
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/** ログイン状態の有効期限。勤務1回分を想定した長さ。 */
export const SESSION_MAX_AGE = "12h";

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(SESSION_MAX_AGE)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

/** Returns the logged-in staff session for a request, or null if not authenticated. */
export async function getSessionFromRequest(req: NextRequest): Promise<SessionPayload | null> {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** Returns the session only if it belongs to an admin, otherwise null. */
export async function requireAdmin(req: NextRequest): Promise<SessionPayload | null> {
  const session = await getSessionFromRequest(req);
  return session?.isAdmin ? session : null;
}
