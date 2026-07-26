import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import type { SessionLog } from "@/lib/types";
import { isGCSEnabled, getAllLogs } from "@/lib/gcsClient";
import { getSessionFromRequest } from "@/lib/session";

// 性能検証テスト用の「測定CSV」をブラウザからダウンロードさせるエンドポイント。
// スタッフがログイン中に押すだけで、コマンド・Cookie操作なしにCSVが手に入る。
// （従来の scripts/measure-report.mjs と同じ集計をサーバー側で行う。）

const LOGS_DIR = path.join(process.cwd(), "logs");

const avg = (a?: number[]) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sec = (ms: number | null | undefined) => (ms === null || ms === undefined ? "" : (ms / 1000).toFixed(2));
const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function loadLocalLogs(): Promise<SessionLog[]> {
  const out: SessionLog[] = [];
  try {
    for (const d of await fs.promises.readdir(LOGS_DIR)) {
      const dir = path.join(LOGS_DIR, d);
      if (!(await fs.promises.stat(dir)).isDirectory()) continue;
      for (const f of await fs.promises.readdir(dir)) {
        if (!f.endsWith(".json")) continue;
        try { out.push(JSON.parse(await fs.promises.readFile(path.join(dir, f), "utf-8"))); } catch { /* skip */ }
      }
    }
  } catch { /* logs dir absent */ }
  return out;
}

function toCsv(logs: SessionLog[]): string {
  logs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const head = ["No", "呼び出し→着信表示(秒)", "発話終了→確定テキスト(秒)", "係員発話→アバター発話開始(秒)", "切断回数", "テキスト欠落件数", "同時接続数", "備考"];
  const rows = [head.join(",")];
  logs.forEach((log, i) => {
    const m = log.metrics;
    const note = [
      log.machineName ?? "",
      log.userLang ?? "",
      new Date(log.startedAt).toLocaleString("ja-JP"),
      m ? `STT計測${m.sttFinalDelaysMs?.length ?? 0}回/TTS計測${m.ttsDelaysMs?.length ?? 0}回` : "測定値なし(旧ログ)",
    ].filter(Boolean).join(" / ");
    rows.push([
      i + 1,
      m ? sec(m.callAnswerDelayMs) : "",
      m ? sec(avg(m.sttFinalDelaysMs)) : "",
      m ? sec(avg(m.ttsDelaysMs)) : "",
      m ? (m.disconnects ?? 0) : "",
      "",  // テキスト欠落＝目視項目のため空欄
      "",  // 同時接続数＝実施時に手入力
      csv(note),
    ].join(","));
  });
  return rows.join("\r\n");
}

export async function GET(req: NextRequest) {
  if (!await getSessionFromRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const logs = isGCSEnabled() ? await getAllLogs() : await loadLocalLogs();
  // BOM を付けると Excel が日本語を文字化けせず開ける。
  const body = "﻿" + toCsv(logs);
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="measure-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
