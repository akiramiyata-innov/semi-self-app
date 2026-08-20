/**
 * 台本から音声を作る。
 *
 *   node scripts/test-agent/make-audio.mjs --lang ja
 *
 * Google TTS で読み上げさせ、ffmpeg で「16kHz・16bit・モノラルの生の音」に直す。
 *
 * ★必ず劣化をかける。
 *   機械の声はきれいすぎて、実際の人の声より認識されやすい。そのまま使うと
 *   認識精度が実際より良く出る。駅の環境に近づけるため、次の3つをかける：
 *     ①電話くらいの音の幅に絞る（高い音・低い音を落とす）
 *     ②音量を下げる（マイクから離れて話している状態に近づける）
 *     ③雑音を混ぜる（駅の環境音の代わり）
 *   それでも人の言い淀み・訛り・話す速さのばらつきは再現できない。
 *   認識精度の数字は「前回との比較」にだけ使うこと。
 */
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./config.mjs";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 読み上げに使う声。アバターと同じ声を使うと認識が有利になりすぎるので別の声にする。 */
const VOICE = {
  ja: { languageCode: "ja-JP", name: "ja-JP-Standard-C" },       // 男性
  en: { languageCode: "en-US", name: "en-US-Standard-D" },
  zh: { languageCode: "cmn-CN", name: "cmn-CN-Standard-B" },
  "zh-TW": { languageCode: "cmn-TW", name: "cmn-TW-Standard-B" },
  ko: { languageCode: "ko-KR", name: "ko-KR-Standard-C" },
  fr: { languageCode: "fr-FR", name: "fr-FR-Standard-B" },
  es: { languageCode: "es-ES", name: "es-ES-Standard-B" },
  th: { languageCode: "th-TH", name: "th-TH-Standard-A" },
};

/** 話す速さを台詞ごとに少し変える（同じ調子で読み続けないように） */
const RATES = [0.95, 1.0, 1.05, 0.92, 1.08];

async function tts(text, langCode, rate) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY が未設定です");
  const v = VOICE[langCode];
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: v.languageCode, name: v.name },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 16000, speakingRate: rate },
    }),
  });
  if (!res.ok) throw new Error(`TTS失敗 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { audioContent } = await res.json();
  return Buffer.from(audioContent, "base64");
}

/**
 * 劣化をかけて、生のPCM（ヘッダなし）にする。
 * NOISE_DB で雑音の大きさを変えられる（既定 -26dB＝静かな駅くらい）。
 */
async function degrade(wavPath, outPcm) {
  const noiseDb = process.env.NOISE_DB ?? "-26";
  const gain = process.env.VOICE_GAIN ?? "0.55";
  const filter = [
    `[0:a]highpass=f=180,lowpass=f=3600,volume=${gain}[v]`,   // ①帯域を絞る ②音量を下げる
    `[1:a]volume=${noiseDb}dB[n]`,                             // ③雑音
    `[v][n]amix=inputs=2:duration=first:dropout_transition=0[a]`,
  ].join(";");
  await run("ffmpeg", [
    "-y", "-i", wavPath,
    "-f", "lavfi", "-i", "anoisesrc=color=brown:sample_rate=16000",
    "-filter_complex", filter, "-map", "[a]",
    "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", outPcm,
  ]);
}

/**
 * 係員の返事の音声を作る（日本語のみ）。
 * ★係員は全言語とも日本語で話すので、1言語ぶん作れば8言語すべてで使い回せる。
 * ★劣化はお客様側より軽くする（係員は事務所のヘッドセットで、駅の騒音は乗らないため）。
 */
async function makeStaffAudio() {
  const scenarios = JSON.parse(await readFile(path.join(HERE, "scenarios", "ja.json"), "utf8"));
  const dir = path.join(HERE, "audio", "staff");
  await mkdir(dir, { recursive: true });
  const prevNoise = process.env.NOISE_DB;
  const prevGain = process.env.VOICE_GAIN;
  process.env.NOISE_DB = process.env.STAFF_NOISE_DB ?? "-40";  // ほぼ無音の環境
  process.env.VOICE_GAIN = process.env.STAFF_VOICE_GAIN ?? "0.8";
  let n = 0;
  for (const sc of scenarios) {
    if (sc.endurance) continue;
    for (const [k, t] of sc.turns.entries()) {
      if (!t.staffJa) continue;
      const base = path.join(dir, `${sc.id}-${k + 1}`);
      await writeFile(`${base}.wav`, await tts(t.staffJa, "ja", RATES[k % RATES.length]));
      await degrade(`${base}.wav`, `${base}.pcm`);
      await unlink(`${base}.wav`);
      n++;
      console.log(`  作成: ${path.relative(HERE, base + ".pcm")}  「${t.staffJa.slice(0, 26)}」`);
    }
  }
  if (prevNoise === undefined) delete process.env.NOISE_DB; else process.env.NOISE_DB = prevNoise;
  if (prevGain === undefined) delete process.env.VOICE_GAIN; else process.env.VOICE_GAIN = prevGain;
  console.log(`\n係員の音声 ${n} 本を作りました（全言語で共通に使えます）。`);
}

async function main() {
  if (process.argv.includes("--staff")) {
    await makeStaffAudio();
    return;
  }
  const i = process.argv.indexOf("--lang");
  const langArg = i >= 0 ? process.argv[i + 1] : "ja";
  const langs = langArg === "all" ? LANGS : LANGS.filter((l) => l.code === langArg);
  if (!langs.length) throw new Error(`知らない言語です: ${langArg}`);

  for (const lang of langs) {
    const file = path.join(HERE, "scenarios", `${lang.code}.json`);
    if (!existsSync(file)) { console.log(`台本がありません: ${file}（とばします）`); continue; }
    const scenarios = JSON.parse(await readFile(file, "utf8"));
    const dir = path.join(HERE, "audio", lang.code);
    await mkdir(dir, { recursive: true });
    for (const sc of scenarios) {
      for (const [n, t] of sc.turns.entries()) {
        const base = path.join(dir, `${sc.id}-${n + 1}`);
        const wav = `${base}.wav`;
        const pcm = `${base}.pcm`;
        if (t.parts) {
          // 耐久用：たくさんの文を1本の長い音声につなげる（文の間は0.4秒あける）
          // ★同じ文は読み上げを1回で済ませて使い回す（耐久は同じ文を3周するため、
          //   そのまま作ると読み上げ回数が3倍になり、時間も料金も無駄になる）
          const gap = Buffer.alloc(16000 * 2 * 0.4);
          const round = [];
          for (const [k, part] of t.parts.entries()) {
            const one = `${base}-p${k}`;
            await writeFile(`${one}.wav`, await tts(part, lang.code, RATES[k % RATES.length]));
            await degrade(`${one}.wav`, `${one}.pcm`);
            round.push(await readFile(`${one}.pcm`), gap);
            await unlink(`${one}.wav`); await unlink(`${one}.pcm`);
          }
          // ★何周させるかは実際の長さから決める。読み上げの速さは言語ごとに違うので、
          //   周回数を決め打ちにすると足りない言語が出る（英語は3周で4分54秒しかなかった）。
          const one = Buffer.concat(round);
          const oneSec = one.length / (16000 * 2);
          const target = t.repeatToSeconds ?? 330;
          const rounds = Math.max(1, Math.ceil(target / oneSec));
          const all = Buffer.concat(Array.from({ length: rounds }, () => one));
          await writeFile(pcm, all);
          const sec = all.length / (16000 * 2);
          console.log(`  作成: ${path.relative(HERE, pcm)}  ${t.parts.length}文×${rounds}周 = ` +
            `${Math.floor(sec / 60)}分${Math.round(sec % 60)}秒（1周 ${Math.round(oneSec)}秒）`);
          if (sec < 290) console.log(`     ⚠ 4.5分の張り替えをまたげません（${Math.round(sec)}秒）`);
          continue;
        }
        await writeFile(wav, await tts(t.userText, lang.code, RATES[n % RATES.length]));
        await degrade(wav, pcm);
        await unlink(wav);
        console.log(`  作成: ${path.relative(HERE, pcm)}  「${t.userText.slice(0, 28)}」`);
      }
    }
  }
  console.log("\n★この音声は機械の声です。認識精度の絶対値ではなく、前回との比較にだけ使ってください。");
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
