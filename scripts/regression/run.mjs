/**
 * 退行テストの一括実行。
 *
 *   npm run test:regression          … 全部（ヘッドレスChromeを使うものも含む）
 *   npm run test:regression:quick    … ソケットだけの速いものだけ
 *   node scripts/regression/run.mjs --only=t3   … 1本だけ
 *
 * 前提: 開発サーバーが http://localhost:3001 で動いていること。
 * 版を上げる（コミット・タグ）前に、必ず全部合格させること。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const quick = args.includes("--quick");
const only = (args.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "");

const TESTS = [
  { file: "t1-recall.mjs", browser: false, what: "v1.48.0 呼び直しで画面が消えない" },
  { file: "t2-order.mjs", browser: false, what: "v1.49.0 分割確定の追い越し" },
  { file: "t3-merge.mjs", browser: false, what: "v1.51.0 分割確定の繋ぎ直し" },
  { file: "t6-ordering.mjs", browser: false, what: "v1.52.0 話し始めの順と確定前の返答の印" },
  { file: "t7-glossary.mjs", browser: false, what: "v1.54.0 用語集の編集（PUT）" },
  { file: "t4-staffui.mjs", browser: true, what: "v1.51/52 係員画面（差し替え・差し込み・印）" },
  { file: "t5-playback.mjs", browser: true, what: "v1.50.0 読み上げ不発とマイク復帰" },
];

const base = process.env.REGRESSION_BASE ?? "http://localhost:3001";
try {
  const r = await fetch(`${base}/user?machine=test-reg-ping&name=ping`, { redirect: "manual" });
  if (r.status >= 500) throw new Error(String(r.status));
} catch (e) {
  console.error(`開発サーバーに届きません（${base}）。先に \`npm run dev\` を起動してください。`, String(e));
  process.exit(2);
}

const results = [];
for (const t of TESTS) {
  if (quick && t.browser) continue;
  if (only && !t.file.startsWith(only)) continue;
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(here, t.file)], { stdio: "inherit", cwd: path.resolve(here, "../..") });
    p.on("exit", (c) => resolve(c ?? 1));
  });
  results.push({ ...t, code, sec: Math.round((Date.now() - started) / 1000) });
}

console.log("\n=== 退行テストの結果 ===");
for (const r of results) console.log(`${r.code === 0 ? "合格" : "不合格"}  ${r.file.padEnd(18)} ${r.what}（${r.sec}秒）`);
const failed = results.filter((r) => r.code !== 0);
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "last-run.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(failed.length ? `\n${failed.length} 本が不合格。版を上げないでください。` : "\n全部合格。");
process.exit(failed.length ? 1 : 0);
