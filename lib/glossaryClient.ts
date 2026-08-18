import { join } from "path";
import type { GlossaryTerm } from "./types";
import { createJsonStore } from "./jsonStore";

const store = createJsonStore<GlossaryTerm[]>({
  gcsPath: "glossary/terms.json",
  localPath: join(process.cwd(), "glossary", "terms.json"),
  empty: () => [],
});

export function getGlossaryTerms(): Promise<GlossaryTerm[]> {
  return store.get();
}

/**
 * Reads the backing store directly, bypassing the in-process cache.
 * The Socket.IO server runs as a separate module instance from the Next.js API
 * routes, so it never sees invalidateGlossaryCache() calls from the admin routes.
 * It uses this fresh read so admin glossary edits reflect immediately in live
 * translation/STT instead of after the cache TTL.
 */
export function getGlossaryTermsFresh(): Promise<GlossaryTerm[]> {
  return store.getFresh();
}

export function saveGlossaryTerms(terms: GlossaryTerm[]): Promise<void> {
  return store.save(terms);
}

export function invalidateGlossaryCache(): void {
  store.invalidate();
}

// ── 二重登録の検査（2026-08-17 ユーザー決定）────────────────────────────────
//
// **同じ言葉は日本語・外国語とも二重登録できない**（運用を複雑にしないため）。
// 問題が出たら二重登録の仕様を再検討する、が現在の取り決め。
//
// 検査は「同じ欄の中」だけで行う。翻訳は方向ごとに見る欄が決まっており
// （日→外は日本語欄、外→日はその言語の欄）、別の欄どうしが競合することは
// 無いため（例: SUICA は日本語欄と英語欄の両方に現れるが、これは1語の登録）。

/** 検査の対象になる欄と、エラー文で使う呼び名。 */
export const GLOSSARY_LANG_LABELS: Array<{ key: keyof GlossaryTerm; label: string }> = [
  { key: "ja", label: "日本語" },
  { key: "en", label: "英語" },
  { key: "zh", label: "中国語（簡体）" },
  { key: "zh-TW", label: "中国語（繁体）" },
  { key: "ko", label: "韓国語" },
  { key: "fr", label: "フランス語" },
  { key: "es", label: "スペイン語" },
  { key: "th", label: "タイ語" },
];

/**
 * 照合用に言葉をそろえる。
 *
 * ★英字の語は翻訳の照合が「空白・ハイフン・大文字小文字を無視」するため
 * （server/socketServer.ts glossaryPattern）、検査も同じ基準にそろえる。
 * ここを厳密一致にすると、見た目が違うだけで実質同じ語
 * （bakuro-yokoyama と BAKUROYOKOYAMA）がすり抜けてしまう。
 */
export function normalizeGlossaryValue(value: string): string {
  const v = value.trim();
  if (/^[A-Za-z0-9 .'-]+$/.test(v)) return v.toLowerCase().replace(/[\s-]+/g, "");
  return v;
}

/** 見つかった二重登録。どの欄の何が、既にどの語で使われているか。 */
export interface GlossaryConflict {
  label: string;
  value: string;
  existingJa: string;
}

/**
 * 追加しようとしている語が、既存の語と同じ言葉を含んでいないか調べる。
 * 最初に見つかった1件を返す（無ければ null）。
 */
export function findGlossaryConflict(
  existing: GlossaryTerm[],
  candidate: Partial<GlossaryTerm>,
): GlossaryConflict | null {
  for (const { key, label } of GLOSSARY_LANG_LABELS) {
    const raw = (candidate[key] as string | undefined)?.trim();
    if (!raw) continue;
    const norm = normalizeGlossaryValue(raw);
    for (const term of existing) {
      const other = (term[key] as string | undefined)?.trim();
      if (!other) continue;
      if (normalizeGlossaryValue(other) === norm) {
        return { label, value: raw, existingJa: term.ja };
      }
    }
  }
  return null;
}

/** 二重登録エラーの文言（登録画面にそのまま表示される）。 */
export function glossaryConflictMessage(c: GlossaryConflict): string {
  return `${c.label}「${c.value}」は、すでに「${c.existingJa}」の登録で使われています。同じ言葉は二重に登録できません（先に既存の語を削除してください）`;
}
