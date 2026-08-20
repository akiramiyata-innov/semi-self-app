/**
 * 自動シナリオテストの採点。
 *
 *   node scripts/test-agent/score.mjs                  … 最新の結果を採点
 *   node scripts/test-agent/score.mjs --file out/xxx.json
 *   node scripts/test-agent/score.mjs --csv           … CSVも書き出す
 *
 * 【何を採点するか】
 *   ① 駅名が正しく届いたか … 用語集の登録あり／なしで分けて集計する（この試験の主目的）
 *   ② 返答が届いたか      … 音声・文字が最後まで届いたか
 *   ③ 遅延              … 話し終わり→確定、係員の発言→音声が出るまで
 *   ④ 障害              … 翻訳の失敗、音声の失敗、テスト以外の着信を取りかけた回数
 *
 * 【判定の考え方】
 *   ・日本語のお客様 … 認識された文字に駅名が入っていれば正解
 *   ・外国語のお客様 … 係員に届いた日本語訳に駅名が入っていれば正解
 *     （お客様が何と言ったかではなく、係員が正しく受け取れたかで判断する）
 *   ・表記のゆれ（きっぷ／切符、わかりました／分かりました）は誤りとして数えない。
 *     用語集による置き換え（スイカ→SUICA）は正解として数える。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const labelOf = (code) => LANGS.find((l) => l.code === code)?.label ?? code;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? true) : fallback;
}

/** 表記のゆれを均す（誤りとして数えないため）。 */
const loosen = (s) =>
  String(s ?? "")
    .replace(/[、。？?！!,.\s「」・]/g, "")
    .replace(/[ａ-ｚＡ-Ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();

async function main() {
  const dir = path.join(HERE, "out");
  const file = arg("file") ?? path.join(dir, (await readdir(dir)).filter((f) => f.endsWith(".json")).sort().pop());
  const j = JSON.parse(await readFile(file, "utf8"));
  console.log(`採点対象: ${path.basename(file)}   宛先: ${j.target}\n`);

  /** 通話ごとの出来事を引きやすくまとめる */
  const byMachine = new Map();
  for (const e of j.events) {
    if (!e.machine && !e.sessionId) continue;
    const key = e.machine ?? null;
    if (key) {
      if (!byMachine.has(key)) byMachine.set(key, []);
      byMachine.get(key).push(e);
    }
  }
  /** 係員側の出来事は sessionId で持っているので、通話IDから機械名を引く */
  const sidToMachine = new Map(j.results.map((r) => [r.sessionId, r.machine]));
  for (const e of j.events) {
    if (e.machine || !e.sessionId) continue;
    const m = sidToMachine.get(e.sessionId);
    if (!m) continue;
    if (!byMachine.has(m)) byMachine.set(m, []);
    byMachine.get(m).push({ ...e, machine: m });
  }

  const rows = [];
  const perLang = new Map();

  for (const r of j.results) {
    const ev = (byMachine.get(r.machine) ?? []).sort((a, b) => a.at - b.at);
    const isJa = r.lang === "ja";

    /**
     * 往復ごとの「時間の窓」を作り、その中に入った出来事だけを拾う。
     * 順番（1つ目・2つ目…）で対応づけると、1回の発話が2つに分かれて確定したときに
     * 以降が全部ずれてしまうため、話し始めから次の話し始めまでで区切る。
     */
    const starts = ev.filter((e) => e.type === "speakStart");
    const windows = starts.map((s, i) => ({
      from: s.at,
      to: starts[i + 1]?.at ?? Infinity,
    }));
    const inWindow = (w, type) => ev.filter((e) => e.type === type && e.at >= w.from && e.at < w.to);
    const joinText = (list) => list.map((e) => e.text ?? "").filter(Boolean).join(" ");
    const stat = perLang.get(r.lang) ?? {
      inGloss: [0, 0], noGloss: [0, 0], replies: [0, 0],
      sttMs: [], ttsMs: [], translationErrors: 0, voiceFailed: 0,
    };

    r.turns.forEach((t, i) => {
      const w = windows[i] ?? { from: Infinity, to: Infinity };
      // 係員が実際に受け取った文字（外国語なら日本語訳、日本語ならそのまま）
      const said = joinText(inWindow(w, "sttFinal"));
      const ufs = inWindow(w, "userFinal");
      const heard = isJa ? said : (joinText(ufs.map((e) => ({ text: e.translatedText ?? e.text }))));

      // 検査する語（1往復に複数入ることがある：04は最大4語）
      const checks = t.checks ?? (t.check ? [t.check] : []);
      if (checks.length === 0) {
        if (!t.endurance) stat.replies[t.replyOk ? 0 : 1]++;
        rows.push({
          言語: labelOf(r.lang), シナリオ: r.scenario, 往復: t.index,
          用語: "", 用語集: "", 判定: "",
          認識文: said, 係員が受け取った文: heard,
          返答音声: t.endurance ? "―（耐久）" : (t.replyOk ? "届いた" : "届かず"),
        });
      }
      for (const c of checks) {
        const ok = loosen(heard).includes(loosen(c.term));
        (c.inGlossary ? stat.inGloss : stat.noGloss)[ok ? 0 : 1]++;
        rows.push({
          言語: labelOf(r.lang), シナリオ: r.scenario, 往復: t.index,
          用語: c.term, 用語集: c.inGlossary ? "あり" : "なし",
          判定: ok ? "正解" : "誤り",
          お客様が言った言葉: c.said ?? "",
          認識文: said, 係員が受け取った文: heard,
          返答音声: t.replyOk ? "届いた" : "届かず",
        });
      }
      if (checks.length > 0 && !t.endurance) stat.replies[t.replyOk ? 0 : 1]++;
    });

    // 耐久：マイクを切らずに話し続けた間、認識が何回出たかと、途切れがないか
    if (r.turns.some((t) => t.endurance)) {
      const finals = ev.filter((e) => e.type === "sttFinal");
      const errs = ev.filter((e) => e.type === "sttError");
      stat.endurance = {
        分: Math.round((r.turns[0].speakMs / 60000) * 10) / 10,
        確定回数: finals.length,
        認識エラー: errs.length,
        最大の空白秒: finals.length < 2 ? null
          : Math.round(Math.max(...finals.slice(1).map((f, i) => f.at - finals[i].at)) / 100) / 10,
      };
    }

    // 遅延（同じ時間の窓の中で組にする）
    windows.forEach((w) => {
      const speakEnd = inWindow(w, "speakEnd")[0];
      const sttFinal = inWindow(w, "sttFinal")[0];      // 最初の確定＝係員が最初に見た文字
      const staffFinal = inWindow(w, "staffSend").concat(inWindow(w, "staffFinal"))[0];
      const ttsAudio = inWindow(w, "ttsAudio")[0];      // 1つ目の音声＝実際に声が始まる時刻
      if (speakEnd && sttFinal && sttFinal.at > speakEnd.at) stat.sttMs.push(sttFinal.at - speakEnd.at);
      if (staffFinal && ttsAudio && ttsAudio.at > staffFinal.at) stat.ttsMs.push(ttsAudio.at - staffFinal.at);
    });
    stat.translationErrors += ev.filter((e) => e.type === "translationError").length;
    stat.voiceFailed += ev.filter((e) => e.type === "staffDelivered" && e.voiceFailed).length;
    perLang.set(r.lang, stat);
  }

  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] / 1000 : null);
  const pct = (p) => (p[0] + p[1] ? `${p[0]}/${p[0] + p[1]}` : "―");

  console.log("言語別のまとめ");
  console.log("─".repeat(92));
  console.log("言語           用語集あり  用語集なし  返答到達   話し終わり→文字  発言→音声  翻訳失敗 音声失敗");
  console.log("─".repeat(92));
  for (const lang of LANGS) {
    const s = perLang.get(lang.code);
    if (!s) continue;
    const f = (v) => (v === null ? "  ―  " : `${v.toFixed(1)}秒`);
    console.log(
      `${lang.label.padEnd(13)}${pct(s.inGloss).padEnd(12)}${pct(s.noGloss).padEnd(12)}` +
      `${pct(s.replies).padEnd(10)} ${f(med(s.sttMs)).padEnd(16)} ${f(med(s.ttsMs)).padEnd(10)} ` +
      `${String(s.translationErrors).padEnd(8)} ${s.voiceFailed}`
    );
  }
  console.log("─".repeat(92));
  const all = [...perLang.values()];
  const sum = (k, i) => all.reduce((n, s) => n + s[k][i], 0);
  console.log(`合計          ${sum("inGloss", 0)}/${sum("inGloss", 0) + sum("inGloss", 1)} 正解    ` +
    `${sum("noGloss", 0)}/${sum("noGloss", 0) + sum("noGloss", 1)} 正解`);
  console.log(`\n※用語集ありは「登録済みの駅名が正しく届いたか」、なしは「未登録の駅名が正しく届いたか」。`);
  console.log(`※遅延は中央値。話し終わり→文字＝お客様が話し終えてから係員の画面に文字が出るまで。`);

  // 耐久試験のまとめ
  const end = LANGS.map((l) => [l, perLang.get(l.code)?.endurance]).filter(([, e]) => e);
  if (end.length) {
    console.log("\n耐久試験（マイクを切らずに話し続ける）");
    console.log("─".repeat(72));
    console.log("言語           話した長さ  確定回数  最大の空白  認識エラー");
    for (const [l, e] of end) {
      console.log(`${l.label.padEnd(13)}${String(e.分 + "分").padEnd(12)}${String(e.確定回数).padEnd(10)}` +
        `${String((e.最大の空白秒 ?? "―") + "秒").padEnd(12)}${e.認識エラー}`);
    }
    console.log("※最大の空白＝確定と確定のあいだが最も開いた時間。約4.5分のストリーム張り替えで");
    console.log("　言葉が落ちていれば、ここが大きくなる。");
  }

  const wrong = rows.filter((r) => r.判定 === "誤り");
  if (wrong.length) {
    console.log(`\n誤って届いた語（${wrong.length}件）`);
    console.log("─".repeat(92));
    for (const w of wrong) {
      const said = w.お客様が言った言葉 ? `（言った言葉: ${w.お客様が言った言葉}）` : "";
      console.log(`  ${w.言語.padEnd(12)} ${String(w.用語).padEnd(7)} 用語集${w.用語集} ${said}`);
      console.log(`      認識: ${String(w.認識文).slice(0, 70)}`);
      console.log(`      届いた文: ${String(w.係員が受け取った文).slice(0, 70)}`);
    }
  }
  if (j.refusedForeignCalls > 0) {
    console.log(`\n⚠ テスト以外の着信を ${j.refusedForeignCalls} 件無視しました（安全装置が働いた）`);
  }
  const failed = j.results.filter((r) => !r.ok);
  if (failed.length) console.log(`\n⚠ 通らなかった通話: ${failed.map((r) => `${r.machine}(${r.error})`).join(", ")}`);

  if (arg("csv")) {
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c]).replace(/"/g, '""')}"`).join(","))].join("\n");
    const out = file.replace(/\.json$/, ".csv");
    await writeFile(out, "﻿" + csv);
    console.log(`\nCSVを書き出しました: ${out}`);
  }
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
