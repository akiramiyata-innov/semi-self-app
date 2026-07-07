import { NextRequest, NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/session";
import { getAssignments, setAssignments } from "@/lib/assignmentClient";

export async function GET(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const stationIds = await getAssignments(session.uid);
  return NextResponse.json({ stationIds });
}

export async function PUT(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { stationIds } = await req.json() as { stationIds: string[] };
  await setAssignments(session.uid, stationIds);
  return NextResponse.json({ ok: true });
}
