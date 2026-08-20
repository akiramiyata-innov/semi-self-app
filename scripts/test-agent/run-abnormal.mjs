/**
 * シナリオ06「異常系」の進行役。
 *
 *   TEST_TARGET=dev TEST_STATION_ID=test-lab SESSION_SECRET=... \
 *     node scripts/test-agent/run-abnormal.mjs
 *
 * 台本ではなく「わざと異常を起こして、決められた通りに振る舞うか」を見る試験。
 * 言語に依存しないので日本語だけで行う。
 *
 * 【試す4件】
 *   A 呼び出しの未応答タイムアウト … 誰も応答しないと60秒で打ち切られるか
 *   B 通話中のお客様の切断        … 係員に通知が届くか
 *   C 同じ端末IDからの再呼び出し   … 前の通話が終了し、理由が伝わるか
 *   D 係員によるマイクの遠隔操作   … お客様側に指示が届くか
 *
 * ★安全装置は通常の試験と同じ。端末名は必ず test- で始める。
 * ★Aは60秒以上かかる。全体で3分ほど。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isProd, log, targetUrl } from "./config.mjs";
import { startFakeStaff } from "./fake-staff.mjs";
import { startFakeKiosk } from "./fake-kiosk.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const record = (side, machine) => (e) => events.push({ side, machine, ...e });

/** 何秒か待つ間に、条件が満たされたら早めに返る。 */
async function waitFor(cond, ms, step = 300) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await sleep(step);
  }
  return cond();
}

const results = [];
function judge(id, title, expected, ok, detail) {
  results.push({ id, title, expected, ok, detail });
  log("結果", `${ok ? "✅" : "❌"} ${id} ${title}  ${detail}`);
}

async function main() {
  const stationId = process.env.TEST_STATION_ID;
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET が未設定です");
  if (!stationId) throw new Error("TEST_STATION_ID が未設定です");
  if (isProd() && process.env.TEST_CONFIRM !== "yes") {
    throw new Error("本番に流そうとしています。意図どおりなら TEST_CONFIRM=yes を付けてください。");
  }
  log("進行役", `異常系試験 開始 ／ 宛先 ${targetUrl()}${isProd() ? "  ★本番★" : ""}`);

  let staff = null;
  const stopAll = async () => { await staff?.stop().catch(() => {}); };
  process.on("SIGINT", async () => { await stopAll(); process.exit(130); });

  try {
    // ── A 呼び出しの未応答タイムアウト ─────────────────────────────────
    // わざと応答しない係員を立てて、60秒で打ち切られることを見る。
    log("A", "呼び出しの未応答タイムアウト（60秒以上かかります）");
    staff = await startFakeStaff({ secret, stationIds: [stationId], ignoreCalls: true, onEvent: record("staff") });
    let k = await startFakeKiosk({
      machineId: "test-ab-A", machineName: "test-ab-A", stationId,
      lang: "ja", bcp47: "ja-JP", onEvent: record("kiosk", "test-ab-A"),
    });
    const tA = Date.now();
    await k.call({ timeoutMs: 3000 }).catch(() => {}); // 応答されないので必ず時間切れ
    const timedOut = await waitFor(
      () => events.some((e) => e.machine === "test-ab-A" && e.type === "callTimeout"), 80000);
    const sec = Math.round((Date.now() - tA) / 1000);
    judge("A", "未応答タイムアウト", "60秒前後で打ち切り",
      timedOut && sec >= 50 && sec <= 75, timedOut ? `${sec}秒で打ち切られました` : "打ち切られませんでした");
    const missed = events.some((e) => e.side === "staff" && e.type === "sawButIgnored");
    judge("A2", "着信が係員に出ていたか", "着信が出る", missed, missed ? "着信を確認" : "着信が出ていない");
    await k.stop();
    await staff.stop();

    // ── B 通話中のお客様の切断 ───────────────────────────────────────
    log("B", "通話中にお客様の通信が切れる");
    staff = await startFakeStaff({ secret, stationIds: [stationId], onEvent: record("staff") });
    k = await startFakeKiosk({
      machineId: "test-ab-B", machineName: "test-ab-B", stationId,
      lang: "ja", bcp47: "ja-JP", onEvent: record("kiosk", "test-ab-B"),
    });
    await k.call();
    await sleep(1500);
    k.cutConnection(); // WiFiが切れた状態
    const noticed = await waitFor(
      () => events.some((e) => e.side === "staff" && e.type === "userDisconnected"), 15000);
    judge("B", "お客様切断の通知", "係員へ通知が届く", noticed,
      noticed ? "通知が届きました" : "通知が届きませんでした");

    // ── C 同じ端末IDからの再呼び出し ──────────────────────────────────
    log("C", "同じ端末IDから続けて呼び出す");
    const k1 = await startFakeKiosk({
      machineId: "test-ab-C", machineName: "test-ab-C", stationId,
      lang: "ja", bcp47: "ja-JP", onEvent: record("kiosk", "test-ab-C-1"),
    });
    await k1.call();
    await sleep(1500);
    const k2 = await startFakeKiosk({
      machineId: "test-ab-C", machineName: "test-ab-C", stationId, // わざと同じ端末ID
      lang: "ja", bcp47: "ja-JP", onEvent: record("kiosk", "test-ab-C-2"),
    });
    await k2.call();
    const kicked = await waitFor(() => k1.endedReason !== null, 12000);
    const told = events.find((e) => e.side === "staff" && e.type === "userDisconnected" && e.reason === "same-machine");
    // お客様側に届くのは call:ended（理由なし）。理由は係員側の通知に入る（C2で見る）。
    judge("C", "同じ端末IDの取り合い", "前の通話が終了する", kicked,
      kicked ? "前の通話が終了しました" : "前の通話が残ったままです");
    judge("C2", "終了の理由が係員に伝わるか", "same-machine と伝わる", !!told,
      told ? "理由が伝わりました" : "理由が伝わっていません");
    await k1.stop();

    // ── D 係員によるマイクの遠隔操作 ──────────────────────────────────
    log("D", "係員画面からお客様のマイクをOFF／ONする");
    const sid = k2.sessionId;
    await waitFor(() => staff.hasCall(sid), 8000);
    staff.setUserMic(sid, false);
    const offOk = await waitFor(() => k2.lastMicCommand === "off", 8000);
    staff.setUserMic(sid, true);
    const onOk = await waitFor(() => k2.lastMicCommand === "on", 8000);
    judge("D", "マイクの遠隔OFF", "お客様側に届く", offOk, offOk ? "OFFが届きました" : "OFFが届きません");
    judge("D2", "マイクの遠隔ON", "お客様側に届く", onOk, onOk ? "ONが届きました" : "ONが届きません");
    await k2.hangUp();
    await k2.stop();
  } finally {
    await stopAll();
  }

  const ok = results.filter((r) => r.ok).length;
  console.log("\n異常系試験のまとめ");
  console.log("─".repeat(72));
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.id.padEnd(3)} ${r.title.padEnd(20)} 期待:${r.expected}`);
    console.log(`        ${r.detail}`);
  }
  console.log("─".repeat(72));
  console.log(`  ${ok} / ${results.length} 件 期待どおり`);

  const outDir = path.join(HERE, "out");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(outDir, `abnormal-${stamp}.json`);
  await writeFile(out, JSON.stringify({ target: targetUrl(), results, events }, null, 2));
  console.log(`\n結果を書き出しました: ${out}`);
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
