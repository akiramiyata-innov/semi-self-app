import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { getStations, saveStations } from "@/lib/stationClient";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const stations = await getStations();
  await saveStations(stations.filter((s) => s.id !== id));
  return NextResponse.json({ ok: true });
}
