/**
 * 台本の自己検査（ネイティブ確認の代わり）。
 *
 *   GOOGLE_API_KEY=... node scripts/test-agent/check-scenarios.mjs
 *
 * 外国語の台詞を機械翻訳で日本語に戻し、「日本語で何を言っているつもりか」（intentJa）
 * と見比べる。意味がずれていれば、ここで気づける。
 *
 * ★これはネイティブの確認の代わりにはならない。
 *   分かるのは「意味が通じているか」まで。「その言い方が現地で自然か」は分からない。
 *   駅名は固有名詞なので逆翻訳では崩れやすく、そこは目視で確認する。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LANGS } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function toJa(texts, from) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY が未設定です");
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: texts, source: from, target: "ja", format: "text" }),
  });
  if (!res.ok) throw new Error(`翻訳失敗 ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return j.data.translations.map((t) => t.translatedText);
}

/** 翻訳APIに渡す言語コード（アプリの内部コードとは別物） */
const API_LANG = { en: "en", zh: "zh-CN", "zh-TW": "zh-TW", ko: "ko", fr: "fr", es: "es", th: "th" };

/** ざっくりした一致度（共通する文字の割合）。厳密さより「大きくずれていないか」を見る。 */
function similarity(a, b) {
  const norm = (s) => String(s).replace(/[、。？?！!,.\s「」]/g, "");
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  const counts = new Map();
  for (const ch of x) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of y) {
    const n = counts.get(ch) ?? 0;
    if (n > 0) { hit++; counts.set(ch, n - 1); }
  }
  return hit / Math.max(x.length, y.length);
}

async function main() {
  let warned = 0, total = 0;
  for (const lang of LANGS) {
    if (lang.code === "ja") continue;
    const file = path.join(HERE, "scenarios", `${lang.code}.json`);
    const scenarios = JSON.parse(await readFile(file, "utf8"));
    const flat = scenarios.flatMap((s) => s.turns.map((t) => ({ ...t, sc: s.id })));
    const back = await toJa(flat.map((t) => t.userText), API_LANG[lang.code]);
    console.log(`\n════ ${lang.label} ════`);
    flat.forEach((t, i) => {
      total++;
      const score = similarity(back[i], t.intentJa);
      const flag = score >= 0.6 ? "✅" : score >= 0.4 ? "△ " : "⚠ ";
      if (score < 0.6) warned++;
      console.log(`${flag} ${t.sc}-${String((i % 8) + 1)} 一致度${(score * 100).toFixed(0)}%`);
      console.log(`    台詞  : ${t.userText}`);
      console.log(`    戻り訳: ${back[i]}`);
      console.log(`    意図  : ${t.intentJa}`);
    });
  }
  console.log(`\n合計 ${total} 台詞 ／ 要確認 ${warned} 件（一致度60%未満）`);
  console.log("※駅名は固有名詞のため逆翻訳で崩れやすく、一致度が低くても問題ないことが多い。目視で確認すること。");
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
