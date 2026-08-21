/**
 * v1.54.0 退行テスト: 用語集の編集（PUT /api/admin/glossary/[id]）。
 *
 * 試験用の語を追加→編集→確認→二重登録の拒否→無い id→削除 の順に通す。
 * 開発サーバーはローカルの glossary/terms.json に保存するので、最後に元どおり
 * （バイト一致）に戻っていることも確かめる。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SignJWT } from "jose";
import { APP_DIR, BASE, Checker, loadSecret } from "./_lib.mjs";

const c = new Checker("t7 用語集の編集（v1.54.0）");
const file = path.join(APP_DIR, "glossary", "terms.json");
const sha = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const before = sha();

const token = await new SignJWT({ uid: "reg-t7-admin", email: "reg-t7-admin@example.invalid", name: "【退行テスト】管理者", isAdmin: true })
  .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(loadSecret()));
const H = { cookie: `staff-session=${token}`, "content-type": "application/json" };
const api = (p, init = {}) => fetch(BASE + p, { ...init, headers: { ...H, ...(init.headers ?? {}) } });

const ja = "退行試験用語ZZ", yomi = "たいこうしけんようご";
let id = null;
try {
  // 追加
  let r = await api("/api/admin/glossary", { method: "POST", body: JSON.stringify({ ja, yomi, en: "regression test term" }) });
  const added = await r.json();
  id = added.term?.id ?? null;
  c.check("試験用の語を追加できる", r.ok && !!id, JSON.stringify(added).slice(0, 120));

  // 編集（英語と韓国語を変える・よみも変える）
  r = await api(`/api/admin/glossary/${id}`, { method: "PUT", body: JSON.stringify({ ja, yomi: "たいこうしけんようごにばん", en: "regression term edited", ko: "회귀 시험 용어" }) });
  const edited = await r.json();
  c.check("編集できる（PUT）", r.ok && edited.term?.en === "regression term edited" && edited.term?.ko === "회귀 시험 용어", JSON.stringify(edited).slice(0, 160));
  c.check("id と日本語は変わらない", edited.term?.id === id && edited.term?.ja === ja, "");

  // 一覧に反映されている・並び順は末尾のまま
  r = await api("/api/admin/glossary");
  const { terms } = await r.json();
  const mine = terms.find((t) => t.id === id);
  c.check("一覧で編集後の内容になっている", mine?.yomi === "たいこうしけんようごにばん" && mine?.en === "regression term edited", JSON.stringify(mine));
  c.check("並び順は変わらない（末尾のまま）", terms.at(-1)?.id === id, "");

  // 必須項目
  r = await api(`/api/admin/glossary/${id}`, { method: "PUT", body: JSON.stringify({ ja, yomi: "" }) });
  c.check("よみが空なら拒否（400）", r.status === 400, `status=${r.status}`);

  // 二重登録: 既存の別の語の日本語に書き換えようとする → 拒否
  const other = terms.find((t) => t.id !== id);
  r = await api(`/api/admin/glossary/${id}`, { method: "PUT", body: JSON.stringify({ ja: other.ja, yomi }) });
  const dup = await r.json();
  c.check("既存の語と同じ日本語への変更は拒否（二重登録）", r.status === 400 && /二重/.test(dup.error ?? ""), dup.error);

  // 自分自身との「重複」は拒否されない（同じ内容で保存し直せる）
  r = await api(`/api/admin/glossary/${id}`, { method: "PUT", body: JSON.stringify({ ja, yomi, en: "regression term edited" }) });
  c.check("同じ語を同じ内容で保存し直すのは通る（自分自身は重複に数えない）", r.ok, `status=${r.status}`);

  // 無い id
  r = await api(`/api/admin/glossary/no-such-id-000`, { method: "PUT", body: JSON.stringify({ ja: "x", yomi: "えっくす" }) });
  c.check("無い id は 404", r.status === 404, `status=${r.status}`);

  // 管理者でないと触れない
  const staffToken = await new SignJWT({ uid: "reg-t7-staff", email: "s@example.invalid", name: "係員", isAdmin: false })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(loadSecret()));
  r = await fetch(`${BASE}/api/admin/glossary/${id}`, { method: "PUT", headers: { cookie: `staff-session=${staffToken}`, "content-type": "application/json" }, body: JSON.stringify({ ja, yomi }) });
  c.check("管理者以外は 403", r.status === 403, `status=${r.status}`);
} finally {
  if (id) await api(`/api/admin/glossary/${id}`, { method: "DELETE" });
}
c.check("片付け後、用語集のファイルは元どおり（バイト一致）", sha() === before, "");
process.exit(c.summary() ? 0 : 1);
