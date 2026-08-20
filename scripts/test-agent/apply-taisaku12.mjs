/**
 * 対策1・2を用語集に反映する（2026-08-20）。
 *
 *   確認だけ: SESSION_SECRET=... node scripts/test-agent/apply-taisaku12.mjs
 *   実行:     SESSION_SECRET=... node scripts/test-agent/apply-taisaku12.mjs --apply
 *
 * 対策1：設置駅5駅を追加（曙橋・岩本町・小川町・浜町・神保町）
 * 対策2：英語・フランス語・スペイン語の空欄14語を埋める
 *
 * ★登録する値は「台本で実際に発話している語」と完全に一致させる。
 *   一致していないと、テストで効果が出たかどうかを測れない。
 * ★同じ欄の中で同じ言葉は二重に登録できない（アプリの決まり）。
 *   ぶつかる語は自動で外し、理由を表示する。
 * ★用語集は「追加」と「削除」しかできないため、既存語の欄を埋めるときは
 *   いったん削除して入れ直す。削除と登録の間は2秒あける
 *   （すぐ入れ直すと、削除が行き渡る前に二重登録と判定される）。
 */
import { SignJWT } from "jose";

const BASE = process.env.TEST_TARGET === "dev"
  ? "http://localhost:3001"
  : "https://semi-self-app-production.up.railway.app";
const APPLY = process.argv.includes("--apply");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 対策1：追加する設置駅。値は台本の発話と一致させてある。 */
const NEW_STATIONS = [
  { ja: "曙橋", yomi: "あけぼのばし", en: "Akebonobashi", zh: "曙桥", "zh-TW": "曙橋",
    ko: "아케보노바시", fr: "Akebonobashi", es: "Akebonobashi", th: "อาเคโบโนบาชิ" },
  { ja: "岩本町", yomi: "いわもとちょう", en: "Iwamotocho", zh: "岩本町", "zh-TW": "岩本町",
    ko: "이와모토초", fr: "Iwamotocho", es: "Iwamotocho", th: "อิวาโมโตโช" },
  { ja: "小川町", yomi: "おがわまち", en: "Ogawamachi", zh: "小川町", "zh-TW": "小川町",
    ko: "오가와마치", fr: "Ogawamachi", es: "Ogawamachi", th: "โอกาวามาจิ" },
  { ja: "浜町", yomi: "はまちょう", en: "Hamacho", zh: "浜町", "zh-TW": "濱町",
    ko: "하마초", fr: "Hamacho", es: "Hamacho", th: "ฮามาโช" },
  { ja: "神保町", yomi: "じんぼうちょう", en: "Jimbocho", zh: "神保町", "zh-TW": "神保町",
    ko: "진보초", fr: "Jimbocho", es: "Jimbocho", th: "จิมโบโจ" },
];

/** 対策2：英・仏・西の空欄を埋める。値は台本の発話と一致させてある。 */
const FILL = {
  切符: { en: "ticket", fr: "billet", es: "billete" },
  チャージ: { en: "top up", fr: "recharge", es: "recarga" },
  残高: { en: "balance", fr: "solde", es: "saldo" },
  領収書: { en: "receipt", fr: "reçu", es: "recibo" },
  運賃: { en: "fare", fr: "tarif", es: "tarifa" },
  改札口: { en: "ticket gate", fr: "portillon", es: "puerta de acceso" },
  エレベーター: { en: "elevator", fr: "ascenseur", es: "ascensor" },
  各駅停車: { en: "local train", fr: "train omnibus", es: "tren local" },
  特急: { en: "limited express", fr: "train express", es: "tren expreso" },
  乗り換え: { en: "transfer", fr: "correspondance", es: "transbordo" },
  ホーム: { en: "platform", fr: "quai", es: "andén" },
  電車: { en: "train", fr: "train", es: "tren" },
  構内図: { en: "station layout map", fr: "plan de la gare", es: "plano de la estación" },
  急行: { en: "express train", fr: "express", es: "tren expreso" },
};

/** アプリと同じ規則で正規化して比べる（英字は空白・ハイフン・大小を無視）。 */
const norm = (v) => String(v ?? "").trim().replace(/[\s-]/g, "").toLowerCase();

async function main() {
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET が未設定です");
  const token = await new SignJWT({ uid: "t12", email: "innov20080303@gmail.com", name: "対策1・2", isAdmin: true })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("40m")
    .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
  const cookie = `staff-session=${token}`;
  const h = { cookie, "content-type": "application/json" };
  const get = async () => {
    const r = await fetch(`${BASE}/api/admin/glossary`, { headers: { cookie } });
    if (!r.ok) throw new Error(`用語集を読めません: ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j : (j.terms ?? j.items ?? []);
  };

  const terms = await get();
  console.log(`宛先 ${BASE} ／ 現在 ${terms.length} 語\n`);

  // ── 二重登録にならないか、変更後の姿で確かめる ──────────────────────
  const planned = terms.map((t) => ({ ...t }));
  const skipped = [];
  const LANGS = ["ja", "en", "zh", "zh-TW", "ko", "fr", "es", "th"];
  const used = {};
  for (const k of LANGS) {
    used[k] = new Map();
    for (const t of planned) if (t[k]) used[k].set(norm(t[k]), t.ja);
  }

  // 対策2：空欄を埋める（ぶつかるものは外す）
  const fills = [];
  for (const [ja, vals] of Object.entries(FILL)) {
    const t = planned.find((x) => x.ja === ja);
    if (!t) { skipped.push([ja, "―", "用語集にこの語がありません"]); continue; }
    const put = {};
    for (const [k, v] of Object.entries(vals)) {
      if (t[k]) { skipped.push([ja, k, `すでに「${t[k]}」が入っています`]); continue; }
      const owner = used[k].get(norm(v));
      if (owner) { skipped.push([ja, k, `「${v}」は「${owner}」で使用済み（二重登録は不可）`]); continue; }
      used[k].set(norm(v), ja);
      put[k] = v;
    }
    if (Object.keys(put).length) fills.push({ term: t, put });
  }

  // 対策1：駅を追加（ぶつかるものは外す）
  const adds = [];
  for (const st of NEW_STATIONS) {
    let ng = null;
    for (const k of LANGS) {
      if (!st[k]) continue;
      const owner = used[k].get(norm(st[k]));
      if (owner) { ng = `${k}「${st[k]}」は「${owner}」で使用済み`; break; }
    }
    if (ng) { skipped.push([st.ja, "―", ng]); continue; }
    for (const k of LANGS) if (st[k]) used[k].set(norm(st[k]), st.ja);
    adds.push(st);
  }

  console.log("■ 対策1：追加する設置駅");
  for (const s of adds) console.log(`  ${s.ja}（${s.yomi}）  en=${s.en} zh=${s.zh} ko=${s.ko} th=${s.th}`);
  console.log(`\n■ 対策2：空欄を埋める語（${fills.length}語）`);
  for (const f of fills) {
    console.log(`  ${f.term.ja.padEnd(8)} ${Object.entries(f.put).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  }
  if (skipped.length) {
    console.log(`\n■ 登録しないもの（${skipped.length}件）`);
    for (const [ja, k, why] of skipped) console.log(`  ${ja.padEnd(8)} ${String(k).padEnd(4)} ${why}`);
  }

  if (!APPLY) { console.log("\n（確認のみ。実行するには --apply を付けてください）"); return; }

  console.log("\n実行します");
  let ok = 0, ng = 0;
  // 対策2：削除→入れ直し（間を2秒あける）
  for (const { term, put } of fills) {
    const d = await fetch(`${BASE}/api/admin/glossary/${term.id}`, { method: "DELETE", headers: { cookie } });
    if (!d.ok) { console.log(`  ❌ ${term.ja} の削除に失敗 (${d.status})`); ng++; continue; }
    await sleep(2000);
    const body = { ja: term.ja, yomi: term.yomi, en: term.en, zh: term.zh, "zh-TW": term["zh-TW"],
      ko: term.ko, fr: term.fr, es: term.es, th: term.th, ...put };
    let done = false;
    for (let i = 0; i < 3 && !done; i++) {
      const p = await fetch(`${BASE}/api/admin/glossary`, { method: "POST", headers: h, body: JSON.stringify(body) });
      if (p.ok) { done = true; break; }
      console.log(`     ${term.ja} 登録${i + 1}回目 失敗 ${p.status}: ${(await p.text()).slice(0, 80)}`);
      await sleep(3000);
    }
    if (done) { ok++; process.stdout.write(`\r  空欄埋め ${ok}/${fills.length}`); }
    else { console.log(`  ❌ ${term.ja} を戻せませんでした。控えから復旧してください`); ng++; }
    await sleep(500);
  }
  console.log("");
  // 対策1：駅の追加
  for (const st of adds) {
    const p = await fetch(`${BASE}/api/admin/glossary`, { method: "POST", headers: h, body: JSON.stringify(st) });
    if (p.ok) { console.log(`  ✅ ${st.ja} を追加`); ok++; }
    else { console.log(`  ❌ ${st.ja} の追加に失敗 ${p.status}: ${(await p.text()).slice(0, 80)}`); ng++; }
    await sleep(500);
  }

  const after = await get();
  console.log(`\n確認: ${terms.length} 語 → ${after.length} 語（+${after.length - terms.length}）`);
  const stillEmpty = (k) => after.filter((x) => !x[k]).map((x) => x.ja);
  for (const k of ["en", "fr", "es"]) {
    const e = stillEmpty(k);
    console.log(`  ${k} の空欄: ${e.length}語 ${e.length ? "→ " + e.join("・") : "✅"}`);
  }
  console.log(ng ? `\n⚠ 失敗 ${ng} 件。控えと突き合わせてください` : "\n失敗なし");
}

main().catch((e) => { console.error("エラー:", e.message); process.exit(1); });
