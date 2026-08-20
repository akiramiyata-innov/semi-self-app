/**
 * 対策6の検証：「話し終わった」と判定するまでの無音時間（speechEndTimeout）を変えて、
 * ①どれだけ速くなるか ②間を取って話す人の言葉が途中で切られないか を実測する。
 *
 *   # サーバー側に値を設定して起動しておく（例）
 *   STT_SPEECH_END_TIMEOUT_MS=800 npm run dev
 *   # 別の端末で
 *   TEST_TARGET=dev TEST_STATION_ID=test-lab SESSION_SECRET=... \
 *     node scripts/test-agent/measure-endpoint.mjs --label 800ms
 *
 * 【測ること】
 *   ・話し終わり→確定までの時間（T9）
 *   ・1つの発話が いくつの確定に分かれたか（＝途中で切られた回数）
 *   ・認識された文が、言ったこととどれだけ一致しているか
 *
 * 【音声】
 *   間の無い文（ふつうの話し方）と、途中に0.6〜2.0秒の間を入れた文の両方を流す。
 *   間の長さごとに分けて集計するので、「何秒の間まで耐えられるか」が分かる。
 */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIO, isProd, log, targetUrl } from "./config.mjs";
import { startFakeStaff } from "./fake-staff.mjs";
import { startFakeKiosk } from "./fake-kiosk.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(HERE, "audio", "endpoint");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : fallback;
}

/** 検証に使う文。前半と後半の間に「間」を入れる。 */
const CASES = [
  { id: "p000", gapMs: 0, a: "すみません、日暮里までの行き方を教えてください。", b: "", key: "行き方" },
  { id: "p600", gapMs: 600, a: "すみません、", b: "日暮里までの行き方を教えてください。", key: "行き方" },
  { id: "p1000", gapMs: 1000, a: "えーっと、", b: "日暮里までの行き方を教えてください。", key: "行き方" },
  { id: "p1500", gapMs: 1500, a: "乗り換えのことなんですが、", b: "馬喰横山で降りればいいですか。", key: "降りれば" },
  { id: "p2000", gapMs: 2000, a: "あの、ちょっと聞きたいんですけど、", b: "改札口はどちらですか。", key: "どちら" },
];

async function tts(text) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY が未設定です");
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: "ja-JP", name: "ja-JP-Standard-C" },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000, speakingRate: 1.0 },
    }),
  });
  if (!res.ok) throw new Error(`TTS失敗 ${res.status}`);
  return Buffer.from((await res.json()).audioContent, "base64");
}

async function degrade(wav, pcm) {
  await run("ffmpeg", ["-y", "-i", wav,
    "-f", "lavfi", "-i", "anoisesrc=color=brown:sample_rate=16000",
    "-filter_complex",
    "[0:a]highpass=f=180,lowpass=f=3600,volume=0.55[v];[1:a]volume=-26dB[n];[v][n]amix=inputs=2:duration=first[a]",
    "-map", "[a]", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", pcm]);
}

/** 間つきの音声を作る。間の部分は「同じ部屋の暗騒音」で埋める（完全な無音にしない）。 */
async function buildAudio() {
  await mkdir(AUDIO_DIR, { recursive: true });
  for (const c of CASES) {
    const out = path.join(AUDIO_DIR, `${c.id}.pcm`);
    if (existsSync(out)) continue;
    const parts = [];
    for (const [k, text] of [c.a, c.b].filter(Boolean).entries()) {
      const base = path.join(AUDIO_DIR, `${c.id}-${k}`);
      await writeFile(`${base}.wav`, await tts(text));
      await degrade(`${base}.wav`, `${base}.pcm`);
      parts.push(await readFile(`${base}.pcm`));
      await unlink(`${base}.wav`); await unlink(`${base}.pcm`);
    }
    let buf;
    if (parts.length === 1) {
      buf = parts[0];
    } else {
      // 間は、前半の末尾0.3秒（暗騒音）を繰り返して作る
      const tail = parts[0].subarray(Math.max(0, parts[0].length - 16000 * 2 * 0.3));
      const need = Math.ceil((16000 * 2 * c.gapMs) / 1000);
      const gap = Buffer.alloc(need);
      for (let i = 0; i < need; i += tail.length) tail.copy(gap, i, 0, Math.min(tail.length, need - i));
      buf = Buffer.concat([parts[0], gap, parts[1]]);
    }
    await writeFile(out, buf);
    console.log(`  音声を作成: ${c.id}（間 ${c.gapMs}ms・全体 ${(buf.length / 32000).toFixed(1)}秒）`);
  }
}

async function main() {
  const label = arg("label", "既定");
  const repeat = Number(arg("repeat", "3"));
  const stationId = process.env.TEST_STATION_ID;
  const secret = process.env.SESSION_SECRET;
  if (!secret || !stationId) throw new Error("SESSION_SECRET と TEST_STATION_ID が必要です");
  if (isProd() && process.env.TEST_CONFIRM !== "yes") {
    throw new Error("本番に流そうとしています。TEST_CONFIRM=yes を付けてください。");
  }

  await buildAudio();
  log("検証", `speechEndTimeout = ${label} ／ 宛先 ${targetUrl()} ／ 各${repeat}回`);

  const events = [];
  const staff = await startFakeStaff({ secret, stationIds: [stationId], onEvent: (e) => events.push(e) });
  const rows = [];
  try {
    for (const c of CASES) {
      for (let n = 0; n < repeat; n++) {
        const machine = `test-ep-${c.id}-${n + 1}`;
        const kiosk = await startFakeKiosk({
          machineId: machine, machineName: machine, stationId,
          lang: "ja", bcp47: "ja-JP",
          onEvent: (e) => events.push({ machine, ...e }),
        });
        try {
          await kiosk.call();
          staff.setReplies(kiosk.sessionId, ["承知しました。"], null); // 返事は文字（測定対象外）
          const t0 = Date.now();
          await kiosk.speak(path.join(AUDIO_DIR, `${c.id}.pcm`));
          const ev = events.filter((e) => e.machine === machine).sort((a, b) => a.at - b.at);
          const se = ev.find((e) => e.type === "speakEnd");
          const finals = ev.filter((e) => e.type === "sttFinal");
          const joined = finals.map((f) => f.text ?? "").join("");
          rows.push({
            間: c.gapMs, 回: n + 1,
            // 最初の確定までの秒（係員が最初の文字を見るまで）
            最初の確定秒: se && finals[0] ? Math.round((finals[0].at - se.at) / 100) / 10 : null,
            // 全部届くまでの秒（用件が伝わるまで）。話し終わりからの時間。
            全部届く秒: se && finals.length ? Math.round((finals[finals.length - 1].at - se.at) / 100) / 10 : null,
            分割数: finals.length,
            用件が届いた: joined.includes(c.key),
            認識文: finals.map((f) => f.text).join(" ／ "),
            言った文: (c.a + c.b),
          });
          await kiosk.hangUp();
        } finally {
          await kiosk.stop();
        }
        await sleep(1500);
      }
    }
  } finally {
    await staff.stop();
  }

  // まとめ
  console.log(`\n■ speechEndTimeout = ${label}`);
  console.log("間(ms)  最初の確定  全部届く  分割数  用件が届いた");
  console.log("─".repeat(58));
  const byGap = {};
  for (const r of rows) (byGap[r.間] = byGap[r.間] ?? []).push(r);
  const med = (a) => (a.length ? a.sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  for (const [gap, list] of Object.entries(byGap)) {
    const f = med(list.map((r) => r.最初の確定秒).filter((x) => x !== null));
    const l = med(list.map((r) => r.全部届く秒).filter((x) => x !== null));
    const sp = (list.reduce((n, r) => n + r.分割数, 0) / list.length).toFixed(1);
    const ok = list.filter((r) => r.用件が届いた).length;
    console.log(`${String(gap).padStart(6)}  ${String(f ?? "―").padStart(9)}秒  ` +
      `${String(l ?? "―").padStart(6)}秒  ${String(sp).padStart(5)}  ${ok}/${list.length}`);
  }
  console.log("\n※最初の確定＝係員が最初の文字を見るまで（話し終わりから）。マイナスは話している途中で確定したこと。");
  console.log("※全部届く＝用件まで含めて届き切るまで。係員が返答を判断できるようになる時刻。");
  console.log("※分割数＝1回の発話がいくつのメッセージに分かれたか。多いほど係員は断片を見ることになる。");
  console.log("※用件が届いた＝後半の要点（行き方／降りれば／どちら）が届いたか。内容が失われていないかの確認。");

  const out = path.join(HERE, "out", `endpoint-${label.replace(/[^\w-]/g, "")}-${Date.now()}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ label, target: targetUrl(), rows, events }, null, 2));
  console.log(`\n結果: ${out}`);
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
