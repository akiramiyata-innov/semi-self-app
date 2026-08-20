/**
 * 自動シナリオテストの進行役。
 *
 *   TEST_TARGET=dev  node scripts/test-agent/run.mjs --lang ja
 *   TEST_TARGET=prod TEST_CONFIRM=yes SESSION_SECRET=... TEST_STATION_ID=... \
 *     node scripts/test-agent/run.mjs --lang all
 *
 * 【必ず守ること】
 *   ・本番へ流すときは TEST_CONFIRM=yes を明示する（うっかり実行の防止）
 *   ・終わったら疑似係員を必ず止める。この進行役は Ctrl+C や異常終了でも止める。
 *   ・1通話ずつ順番に行う（同時にはしない）。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS, isProd, log, targetUrl } from "./config.mjs";
import { startFakeStaff } from "./fake-staff.mjs";
import { startFakeKiosk } from "./fake-kiosk.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const langArg = arg("lang", "ja");
  const only = arg("scenario", null);
  const skip = (arg("skip", "") || "").split(",").filter(Boolean);   // 例: --skip 05
  const stationId = process.env.TEST_STATION_ID;
  const secret = process.env.SESSION_SECRET;

  if (!secret) throw new Error("SESSION_SECRET が未設定です");
  if (!stationId) throw new Error("TEST_STATION_ID（テスト専用駅のID）が未設定です");
  if (isProd() && process.env.TEST_CONFIRM !== "yes") {
    throw new Error("本番に流そうとしています。意図どおりなら TEST_CONFIRM=yes を付けてください。");
  }

  const langs = langArg === "all" ? LANGS : LANGS.filter((l) => l.code === langArg);
  if (langs.length === 0) throw new Error(`知らない言語です: ${langArg}`);

  log("進行役", `宛先 ${targetUrl()}${isProd() ? "  ★本番★" : ""}`);
  log("進行役", `言語 ${langs.map((l) => l.label).join("・")}`);

  const events = [];
  const results = [];

  const staff = await startFakeStaff({
    secret,
    stationIds: [stationId],
    onEvent: (e) => events.push({ side: "staff", ...e }),
  });

  // どんな終わり方をしても疑似係員を止める（本番の待機一覧に残さない）
  let stopped = false;
  const stopAll = async () => {
    if (stopped) return;
    stopped = true;
    await staff.stop().catch(() => {});
  };
  process.on("SIGINT", async () => { log("進行役", "中断されました"); await stopAll(); process.exit(130); });
  process.on("SIGTERM", async () => { await stopAll(); process.exit(143); });

  try {
    for (const lang of langs) {
      const file = path.join(HERE, "scenarios", `${lang.code}.json`);
      if (!existsSync(file)) { log("進行役", `台本がありません: ${file}（とばします）`); continue; }
      const scenarios = JSON.parse(await readFile(file, "utf8"));
      for (const sc of scenarios) {
        if (only && sc.id !== only) continue;
        if (skip.includes(sc.id)) { log("進行役", `${lang.label} ${sc.id} はとばします`); continue; }
        results.push(await runOne({ lang, sc, staff, stationId, events }));
        await sleep(3000); // 通話と通話の間をあける
      }
    }
  } finally {
    await stopAll();
  }

  const outDir = path.join(HERE, "out");
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(outDir, `run-${stamp}.json`);
  await writeFile(outFile, JSON.stringify({
    target: targetUrl(), startedAt: stamp, results, events,
    refusedForeignCalls: staff.refusedCount,
  }, null, 2));
  log("進行役", `結果を書き出しました: ${outFile}`);
  if (staff.refusedCount > 0) {
    log("進行役", `⚠ テスト以外の着信を ${staff.refusedCount} 件無視しました（安全装置が働いた＝一般のお客様の呼び出しが届いていた）`);
  }
}

async function runOne({ lang, sc, staff, stationId, events }) {
  const machine = `test-${lang.code}-${sc.id}`;
  log("通話", `── ${lang.label} / ${sc.title}（${machine}）──`);
  const kiosk = await startFakeKiosk({
    machineId: machine, machineName: machine, stationId,
    lang: lang.code, bcp47: lang.bcp47,
    onEvent: (e) => events.push({ side: "kiosk", machine, ...e }),
  });
  const turns = [];
  try {
    await kiosk.call();
    // 係員の返事の音声（日本語・全言語共通）。あれば係員は声で話す。
    // 無ければ従来どおり文字で送る（STAFF_TEXT=1 で強制的に文字にもできる）。
    const staffAudio = (process.env.STAFF_TEXT === "1" || sc.endurance) ? null
      : sc.turns.map((_, i) => path.join(HERE, "audio", "staff", `${sc.id}-${i + 1}.pcm`));
    staff.setReplies(kiosk.sessionId, sc.endurance ? [] : sc.turns.map((t) => t.staffJa), staffAudio);
    for (const [i, t] of sc.turns.entries()) {
      const pcm = path.join(HERE, "audio", lang.code, `${sc.id}-${i + 1}.pcm`);
      if (!existsSync(pcm)) throw new Error(`音声がありません: ${pcm}`);
      const t0 = Date.now();
      await kiosk.speak(pcm, { keepMicOn: !!sc.endurance });
      const spoke = Date.now();
      // 耐久はマイクを切らずに話し切るだけ。返事は待たない
      // ★係員が話し終わるのを待ってから、音声が届き切るのを待つ。
      //   長い返事は認識が複数回に分かれ、そのぶん時間がかかるため。
      let reply = { ok: true, audioCount: 0 };
      if (!sc.endurance) {
        if (staffAudio) await staff.waitTurn(kiosk.sessionId, i + 1);
        reply = await kiosk.waitReply();
      }
      turns.push({
        index: i + 1, expected: t.userText, expectedJa: t.userTextJa,
        staffJa: t.staffJa, check: t.check ?? null, checks: t.checks ?? null,
        endurance: !!sc.endurance,
        speakMs: spoke - t0, replyOk: reply.ok, audioPieces: reply.audioCount,
      });
    }
    if (sc.endurance) kiosk.stopMic();
    await kiosk.hangUp();
    return { lang: lang.code, scenario: sc.id, title: sc.title, machine, sessionId: kiosk.sessionId, ok: true, turns };
  } catch (e) {
    log("通話", `⚠ 失敗: ${e.message}`);
    await kiosk.hangUp().catch(() => {});
    return { lang: lang.code, scenario: sc.id, machine, sessionId: kiosk.sessionId, ok: false, error: e.message, turns };
  } finally {
    await kiosk.stop();
  }
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
