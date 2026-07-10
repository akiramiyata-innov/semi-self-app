import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export interface SessionPayload {
  uid: string;
  email: string;
  name: string;
  isAdmin: boolean;
}

export const SESSION_COOKIE_NAME = "staff-session";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 60 * 60 * 24 * 7, // 7 days
  path: "/",
};

function getSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("7d")
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
