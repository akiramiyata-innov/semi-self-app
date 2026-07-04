import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { getAssignments, setAssignments } from "@/lib/assignmentClient";

async function requireAuth(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function GET(req: NextRequest) {
  const session = await requireAuth(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const stationIds = await getAssignments(session.uid);
  return NextResponse.json({ stationIds });
}

export async function PUT(req: NextRequest) {
  const session = await requireAuth(req);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { stationIds } = await req.json() as { stationIds: string[] };
  await setAssignments(session.uid, stationIds);
  return NextResponse.json({ ok: true });
}
