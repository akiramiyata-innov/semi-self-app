import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, getSessionFromRequest } from "@/lib/session";
import { getStations, saveStations } from "@/lib/stationClient";

export async function GET(req: NextRequest) {
  if (!await getSessionFromRequest(req)) {
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
  if (!code?.trim()) {
    return NextResponse.json({ error: "駅コードは必須です" }, { status: 400 });
  }
  const stations = await getStations();
  const newStation = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    name: name.trim(),
    code: code.trim(),
  };
  await saveStations([...stations, newStation]);
  return NextResponse.json({ ok: true, station: newStation });
}
