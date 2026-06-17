import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

const LOGS_DIR = path.join(process.cwd(), "logs");

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  if (!sessionId || sessionId.includes("..") || sessionId.includes("/")) {
    return NextResponse.json({ error: "invalid sessionId" }, { status: 400 });
  }

  try {
    const dateDirs = await fs.promises.readdir(LOGS_DIR);
    for (const dateDir of dateDirs) {
      const filePath = path.join(LOGS_DIR, dateDir, `${sessionId}.json`);
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        return NextResponse.json(JSON.parse(content));
      } catch {
        // not in this date dir, try next
      }
    }
  } catch {
    // LOGS_DIR doesn't exist
  }

  return NextResponse.json({ error: "not found" }, { status: 404 });
}
