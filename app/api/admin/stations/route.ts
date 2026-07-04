import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { getStations, saveStations } from "@/lib/stationClient";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
}

async function requireAuth(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function GET(req: NextRequest) {
  if (!await requireAuth(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const stations = await getStations();
  return NextResponse.json({ stations });
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { name, code } = await req.json() as { name: string; code?: string };
  if (!name?.trim()) {
    return NextResponse.json({ error: "駅名は必須です" }, { status: 400 });
  }
  const stations = await getStations();
  const newStation = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    name: name.trim(),
    ...(code?.trim() ? { code: code.trim() } : {}),
  };
  await saveStations([...stations, newStation]);
  return NextResponse.json({ ok: true, station: newStation });
}
