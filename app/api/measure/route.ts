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

/** 通話の終了時刻。古いログで endedAt が無い場合は開始＋通話秒数で補う。 */
function endOf(log: SessionLog): number {
  if (log.endedAt) return log.endedAt;
  return (log.startedAt ?? 0) + (log.durationSeconds ?? 0) * 1000;
}

/**
 * その通話と時間帯が重なっていた通話の数（自分を含む）。
 * 「2件同時対応時の遅延増加」を見るために必要な情報を、手入力なしで求める。
 */
function concurrency(log: SessionLog, all: SessionLog[]): number {
  const s = log.startedAt ?? 0;
  const e = endOf(log);
  if (!s || e <= s) return 1;
  return all.filter((o) => {
    const os = o.startedAt ?? 0;
    const oe = endOf(o);
    return os && oe > os && os < e && s < oe; // 期間が少しでも重なれば同時
  }).length;
}

function toCsv(logs: SessionLog[]): string {
  logs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const head = ["No", "呼び出し→着信表示(秒)", "発話終了→確定テキスト(秒)", "係員発話→アバター発話開始(秒)", "切断回数", "同時通話数", "備考"];
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
      concurrency(log, logs), // 通話時間の重なりから自動判定（1＝単独、2＝2件同時…）
      csv(note),
    ].join(","));
  });
  return rows.join("\r\n");
}

export async function GET(req: NextRequest) {
  if (!await getSessionFromRequest(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let logs = isGCSEnabled() ? await getAllLogs() : await loadLocalLogs();
  // ?test=1 のときは、機械名（name=）が "test-" で始まる通話＝性能検証テスト分だけに絞る。
  // 一般のお客様の通話が混ざらないので、そのまま集計に使える（スタッフ画面のボタンはこれを使う）。
  const testOnly = req.nextUrl.searchParams.get("test") === "1";
  if (testOnly) {
    logs = logs.filter((l) => (l.machineName ?? "").toLowerCase().startsWith("test-"));
  }
  // BOM を付けると Excel が日本語を文字化けせず開ける。
  const body = "﻿" + toCsv(logs);
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const filename = testOnly ? `measure-test-${date}.csv` : `measure-${date}.csv`;
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
