#!/usr/bin/env node
/**
 * 性能検証テスト：自動測定レポート生成
 *
 * 通話ログ（SessionLog.metrics）から、評価記入シートの「自動測定結果」タブに
 * そのまま貼り付けられる CSV を作る。
 *
 * 使い方:
 *   # 本番/ステージングから取得（スタッフでログイン後、ブラウザのCookieを渡す）
 *   node scripts/measure-report.mjs --url https://<host> --cookie "<staff-sessionの値>"
 *
 *   # ローカルの logs/ ディレクトリから
 *   node scripts/measure-report.mjs --dir logs
 *
 * 出力: 標準出力にCSV（> measure.csv でファイル保存）
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const url = get("--url");
const cookie = get("--cookie");
const dir = get("--dir");

if (!dir && !url) {
  console.error("使い方: --dir logs  もしくは  --url https://<host> --cookie <staff-sessionの値>");
  process.exit(1);
}

const avg = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const max = (a) => (a && a.length ? Math.max(...a) : null);
const sec = (ms) => (ms === null || ms === undefined ? "" : (ms / 1000).toFixed(2));

/** ローカルの logs/日付/*.json を全部読む */
function loadFromDir(root) {
  const out = [];
  for (const d of readdirSync(root)) {
    const p = join(root, d);
    if (!statSync(p).isDirectory()) continue;
    for (const f of readdirSync(p)) {
      if (!f.endsWith(".json")) continue;
      try { out.push(JSON.parse(readFileSync(join(p, f), "utf-8"))); } catch { /* 壊れたファイルは飛ばす */ }
    }
  }
  return out;
}

/** APIから一覧→各セッションの詳細を取得 */
async function loadFromApi(base, cookieValue) {
  const headers = { cookie: `staff-session=${cookieValue}` };
  const listRes = await fetch(`${base}/api/logs`, { headers });
  if (!listRes.ok) throw new Error(`一覧の取得に失敗しました (HTTP ${listRes.status})。Cookieの値を確認してください。`);
  const { sessions = [] } = await listRes.json();
  const out = [];
  for (const s of sessions) {
    const r = await fetch(`${base}/api/logs/${s.sessionId}`, { headers });
    if (r.ok) out.push(await r.json());
  }
  return out;
}

const logs = dir ? loadFromDir(dir) : await loadFromApi(url.replace(/\/$/, ""), cookie);
logs.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

const HEAD = [
  "No", "呼び出し→着信表示(秒)", "発話終了→確定テキスト(秒)",
  "係員発話→アバター発話開始(秒)", "切断回数", "テキスト欠落件数", "同時接続数", "備考",
];
const rows = [HEAD.join(",")];

let n = 0, withMetrics = 0;
for (const log of logs) {
  n++;
  const m = log.metrics;
  if (m) withMetrics++;
  const note = [
    log.machineName ?? "",
    log.userLang ?? "",
    new Date(log.startedAt).toLocaleString("ja-JP"),
    m ? `STT計測${m.sttFinalDelaysMs?.length ?? 0}回/TTS計測${m.ttsDelaysMs?.length ?? 0}回` : "測定値なし(旧ログ)",
    m && max(m.sttFinalDelaysMs) !== null ? `STT最大${sec(max(m.sttFinalDelaysMs))}s` : "",
    m && max(m.ttsDelaysMs) !== null ? `TTS最大${sec(max(m.ttsDelaysMs))}s` : "",
  ].filter(Boolean).join(" / ");

  rows.push([
    n,
    m ? sec(m.callAnswerDelayMs) : "",
    m ? sec(avg(m.sttFinalDelaysMs)) : "",
    m ? sec(avg(m.ttsDelaysMs)) : "",
    m ? (m.disconnects ?? 0) : "",
    "",            // テキスト欠落は目視項目のため空欄
    "",            // 同時接続数は実施時に手入力
    `"${note.replace(/"/g, '""')}"`,
  ].join(","));
}

console.log(rows.join("\n"));
console.error(`\n[集計] 通話ログ ${n} 件 / うち測定値あり ${withMetrics} 件`);
if (withMetrics < n) {
  console.error("※ 測定値なしの行は、この機能を入れる前に記録された古いログです。");
}
