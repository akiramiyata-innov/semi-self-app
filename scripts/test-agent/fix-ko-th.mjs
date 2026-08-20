/**
 * 用語集の韓国語欄・タイ語欄を、ローマ字から現地の文字に直す（2026-08-19）。
 *
 *   確認だけ: SESSION_SECRET=... node scripts/test-agent/fix-ko-th.mjs
 *   実行:     SESSION_SECRET=... node scripts/test-agent/fix-ko-th.mjs --apply
 *
 * 【なぜ直すか】
 *   欄の値は音声認識のヒントと、外国語→日本語の照合にも使われる。ローマ字（Nippori）で
 *   登録されていると、実際に「닛포리」「นิปโปริ」と話すお客様の言葉と一致せず、
 *   用語集がまったく効かない。中国語で2026年8月に同じ問題を直したのと同じ対処。
 *   8言語リハーサルでは、韓国語が「登録あり2/6・登録なし3/5」と逆転していた。
 *
 * 【やり方】
 *   このアプリの用語集は「追加」と「削除」しかできない（編集のAPIが無い）。
 *   そこで1語ずつ「削除→すぐ入れ直す」で置き換える。全部消してから入れ直すと、
 *   その間に通話があった場合に用語集が丸ごと効かなくなるため、必ず1語ずつ行う。
 *
 * 【この値はAIが作ったもので、ネイティブの確認を受けていない】
 *   駅名は日本語の読みをその言語の文字で書き写したもの。
 *   鉄道用語はその言語で一般に使われる語。実運用の前に確認を受けることが望ましい。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TEST_TARGET === "dev"
  ? "http://localhost:3001"
  : "https://semi-self-app-production.up.railway.app";
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 日本語 → [韓国語, タイ語]。空文字は「今のままにする」。 */
const NEW = {
  "SUICA": ["스이카", "ซุยกะ"],
  "PASMO": ["파스모", "พาสโม"],
  "振替輸送": ["대체 수송", ""],
  "乗り越し精算": ["초과 요금 정산", "การชำระค่าโดยสารส่วนเกิน"],
  "新宿線": ["신주쿠선", "สายชินจูกุ"],
  "精算": ["", ""],
  "精算機": ["", ""],
  "馬喰横山": ["바쿠로요코야마", "บาคุโระโยโกยามะ"],
  "狸穴町": ["마미아나초", "มามิอานะโช"],
  "舎人": ["도네리", "โทเนริ"],
  "用賀": ["요가", "โยกะ"],
  "碑文谷": ["히몬야", "ฮิมงยะ"],
  "日暮里": ["닛포리", "นิปโปริ"],
  "麻布十番": ["아자부주반", "อาซาบุจูบัง"],
  "舎人ライナー": ["도네리 라이너", "โทเนริไลเนอร์"],
  "南北線": ["난보쿠선", "สายนัมโบกุ"],
  "構内地図": ["", ""],
  "構内図": ["구내 안내도", "ผังสถานี"],
  "急行": ["급행", "รถด่วน"],
  "各駅停車": ["각역정차", "รถจอดทุกสถานี"],
  "特急": ["특급", "รถด่วนพิเศษ"],
  "改札口": ["개찰구", "ประตูตรวจตั๋ว"],
  "ホーム": ["승강장", "ชานชาลา"],
  "エレベーター": ["엘리베이터", "ลิฟต์"],
  "乗り換え": ["환승", "การเปลี่ยนขบวน"],
  "チャージ": ["충전", "การเติมเงิน"],
  "領収書": ["영수증", "ใบเสร็จ"],
  "切符": ["승차권", "ตั๋ว"],
  "運賃": ["운임", "ค่าโดยสาร"],
  "残高": ["잔액", "ยอดคงเหลือ"],
  "電車": ["전철", "รถไฟ"],
};

async function token() {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET が未設定です");
  return new SignJWT({ uid: "gl-fix", email: "innov20080303@gmail.com", name: "用語集修正", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("30m")
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
}

async function main() {
  const cookie = `staff-session=${await token()}`;
  const h = { cookie, "content-type": "application/json" };
  const get = async () => {
    const r = await fetch(`${BASE}/api/admin/glossary`, { headers: { cookie } });
    if (!r.ok) throw new Error(`用語集を読めません: ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : (j.terms ?? j.items ?? []);
  };

  const terms = await get();
  console.log(`宛先 ${BASE} ／ 用語集 ${terms.length} 語\n`);

  // 直したあとの姿を作る
  const planned = terms.map((t) => {
    const [ko, th] = NEW[t.ja] ?? ["", ""];
    return { ...t, ko: ko || t.ko, th: th || t.th };
  });

  // ── 検査①：同じ欄の中で二重にならないか（アプリと同じ規則で照合される）
  let bad = 0;
  for (const key of ["ko", "th"]) {
    const seen = new Map();
    for (const t of planned) {
      const v = (t[key] ?? "").trim();
      if (!v) continue;
      const norm = v.replace(/[\s-]/g, "").toLowerCase();
      if (seen.has(norm)) {
        console.log(`  ⚠ ${key} 欄が重複: 「${v}」が「${seen.get(norm)}」と「${t.ja}」で重なっています`);
        bad++;
      }
      seen.set(norm, t.ja);
    }
  }
  console.log(bad === 0 ? "検査① 二重登録なし ✅" : `検査① 二重登録 ${bad} 件 ❌`);

  // ── 検査②：ローマ字が残っていないか
  const isRoma = (s) => /^[A-Za-z][A-Za-z\s'-]*$/.test(s ?? "");
  const left = planned.filter((t) => isRoma(t.ko) || isRoma(t.th));
  console.log(left.length === 0 ? "検査② ローマ字の残りなし ✅"
    : `検査② ローマ字が残っています: ${left.map((t) => t.ja).join("・")} ⚠`);

  // ── 検査③：空欄がないか
  const empty = planned.filter((t) => !t.ko || !t.th);
  console.log(empty.length === 0 ? "検査③ 空欄なし ✅" : `検査③ 空欄: ${empty.map((t) => t.ja).join("・")} ⚠`);

  console.log("\n直す内容");
  console.log("─".repeat(88));
  console.log("日本語        韓国語（変更前 → 変更後）              タイ語（変更前 → 変更後）");
  console.log("─".repeat(88));
  const changes = [];
  for (const t of terms) {
    const p = planned.find((x) => x.id === t.id);
    const koCh = (t.ko ?? "") !== (p.ko ?? "");
    const thCh = (t.th ?? "") !== (p.th ?? "");
    if (!koCh && !thCh) continue;
    changes.push({ before: t, after: p });
    const f = (a, b, ch) => (ch ? `${a || "(空)"} → ${b}` : `${a}（そのまま）`);
    console.log(`${t.ja.padEnd(12)} ${f(t.ko, p.ko, koCh).padEnd(36)} ${f(t.th, p.th, thCh)}`);
  }
  console.log("─".repeat(88));
  console.log(`変更する語: ${changes.length} / ${terms.length}`);

  if (bad > 0) { console.log("\n二重登録があるため実行しません。"); return; }
  if (!APPLY) { console.log("\n（確認のみ。実行するには --apply を付けてください）"); return; }

  // ── 実行：1語ずつ「削除 → すぐ入れ直す」
  console.log("\n実行します（1語ずつ削除→入れ直し）");
  let done = 0;
  for (const { before, after } of changes) {
    const d = await fetch(`${BASE}/api/admin/glossary/${before.id}`, { method: "DELETE", headers: { cookie } });
    if (!d.ok) { console.log(`  ❌ ${before.ja} の削除に失敗 (${d.status})`); continue; }
    const body = {
      ja: after.ja, yomi: after.yomi, en: after.en, zh: after.zh,
      "zh-TW": after["zh-TW"], ko: after.ko, fr: after.fr, es: after.es, th: after.th,
    };
    const p = await fetch(`${BASE}/api/admin/glossary`, { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!p.ok) {
      console.log(`  ❌ ${before.ja} の登録に失敗 (${p.status}) ${(await p.text()).slice(0, 120)}`);
      console.log(`     ★この語が消えたままです。控えから戻してください。`);
      continue;
    }
    done++;
    process.stdout.write(`\r  ${done}/${changes.length} 完了`);
    await sleep(120); // idが時刻由来のため間を空ける
  }
  console.log("");

  const after = await get();
  const stillRoma = after.filter((t) => isRoma(t.ko) || isRoma(t.th));
  console.log(`\n確認: 用語集 ${after.length} 語（元 ${terms.length} 語）`);
  console.log(stillRoma.length === 0 ? "  ローマ字の残り: なし ✅" : `  ローマ字が残っています: ${stillRoma.map((t) => t.ja).join("・")}`);
  console.log(after.length === terms.length ? "  語数は変わっていません ✅" : "  ⚠ 語数が変わりました。控えと突き合わせてください");

  const out = path.join(HERE, "..", "..", "..", "doc-tools", "backup", "glossary-prod-after-kotf.json");
  await writeFile(out, JSON.stringify(after, null, 2));
  console.log(`  結果を控えました: ${out}`);
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
