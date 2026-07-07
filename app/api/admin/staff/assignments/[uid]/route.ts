import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getAssignments, setAssignments } from "@/lib/assignmentClient";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { uid } = await params;
  const stationIds = await getAssignments(uid);
  return NextResponse.json({ stationIds });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ uid: string }> }
) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { uid } = await params;
  const { stationIds } = await req.json() as { stationIds: string[] };
  await setAssignments(uid, stationIds);
  return NextResponse.json({ ok: true });
}
