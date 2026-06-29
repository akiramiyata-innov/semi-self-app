import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import type { SessionLog, SessionSummary } from "@/lib/types";
import { isGCSEnabled, listLogs } from "@/lib/gcsClient";

const LOGS_DIR = path.join(process.cwd(), "logs");

export async function GET() {
  if (isGCSEnabled()) {
    try {
      const sessions = await listLogs();
      return NextResponse.json({ sessions });
    } catch (e) {
      console.error("[logs API] GCS error:", e);
      return NextResponse.json({ sessions: [] });
    }
  }

  try {
    await fs.promises.access(LOGS_DIR);
  } catch {
    return NextResponse.json({ sessions: [] });
  }

  const summaries: SessionSummary[] = [];

  const dateDirs = await fs.promises.readdir(LOGS_DIR);
  for (const dateDir of dateDirs) {
    const dirPath = path.join(LOGS_DIR, dateDir);
    const stat = await fs.promises.stat(dirPath);
    if (!stat.isDirectory()) continue;

    const files = await fs.promises.readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const content = await fs.promises.readFile(path.join(dirPath, file), "utf-8");
        const log = JSON.parse(content) as SessionLog;
        summaries.push({
          sessionId: log.sessionId,
          machineName: log.machineName,
          userLang: log.userLang,
          startedAt: log.startedAt,
          durationSeconds: log.durationSeconds,
          messageCount: log.transcript.length,
        });
      } catch {
        // skip corrupted files
      }
    }
  }

  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return NextResponse.json({ sessions: summaries });
}
