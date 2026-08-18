import type { GlossaryTerm } from "./types";
import type { LangCode } from "./socketEvents";

/**
 * 外国語の認識結果を、用語集の登録語に寄せる（施策2・2026-08-18）。
 *
 * ★背景：音声認識は音を正しく取れても、同じ発音の別の文字を書き出すことがある。
 * 2026-08-17 の中国語テストで観測された誤認識は**全件が同音・ほぼ同音**だった。
 *   日暮里(rimuli) → 日木里(rimuli) → 訳「昼間」
 *   舍人(sheren)  → 射人/摄人(sheren) → 訳「人を撃ちたい」
 *   狸穴町(lixueting) → 李雪听(lixueting) → 訳「李雪婷さん」（人名）
 *   换乘(huancheng) → 换成(huancheng) → 訳「変装」
 * 日本語には同じ壊れ方に対する読み照合（lib/reading.ts）が既にあり有効だったので、
 * その考え方を外国語へ広げる。**翻訳より前に直す**ので、訳文も連動して正しくなる。
 *
 * 言語ごとに「照合の材料」が違う：
 *  - 中国語（簡体・繁体）… ピンイン（声調なし）。漢字から機械的に得られる
 *  - 英語・仏語・西語 … つづり（大文字小文字・空白・ハイフンの違いを無視）
 *  - 韓国語・タイ語 … 表記そのもの（文字がほぼ発音）
 * 日本語は従来どおり lib/reading.ts（kuromoji の読み）が担当する。
 */

/** 音声認識の言語コード（bcp47）から、用語集の欄の名前へ。 */
export function glossaryFieldOf(bcp47: string): LangCode | null {
  const l = (bcp47 || "").toLowerCase();
  if (l.startsWith("ja")) return null;      // 日本語は reading.ts が担当
  if (l.startsWith("zh-tw") || l.startsWith("cmn-hant")) return "zh-TW";
  if (l.startsWith("zh") || l.startsWith("cmn")) return "zh";
  if (l.startsWith("en")) return "en";
  if (l.startsWith("ko")) return "ko";
  if (l.startsWith("fr")) return "fr";
  if (l.startsWith("es")) return "es";
  if (l.startsWith("th")) return "th";
  return null;
}

const isChinese = (field: LangCode): boolean => field === "zh" || field === "zh-TW";
const isLatin = (field: LangCode): boolean => field === "en" || field === "fr" || field === "es";

/** 照合に使う1語ぶんの情報。 */
export interface ForeignEntry {
  /** 照合の鍵（中国語＝声調なしピンイン／その他＝そろえた表記）。 */
  key: string;
  /** 置き換え先＝用語集に登録されている表記。 */
  term: string;
}

// pinyin-pro は辞書を抱えるため遅延読み込みする（外国語の通話で初めて読む）。
type PinyinFn = (text: string, opts: { toneType: "none"; type: "array" }) => string[];
let pinyinPromise: Promise<PinyinFn | null> | null = null;
function getPinyin(): Promise<PinyinFn | null> {
  if (!pinyinPromise) {
    pinyinPromise = import("pinyin-pro")
      .then((m) => (m as unknown as { pinyin: PinyinFn }).pinyin)
      .catch((e) => { console.error("[stt] ピンインの辞書を読めなかった:", e); return null; });
  }
  return pinyinPromise;
}

/** 辞書の読み込みを先に始めて、最初の認識結果までに準備を整える。 */
export function warmUpPinyin(): void {
  void getPinyin();
}

/** ラテン文字の語をそろえる（大文字小文字・空白・ハイフンの違いを無視）。 */
function normalizeLatin(s: string): string {
  return s.toLowerCase().replace(/[\s-]+/g, "");
}

/**
 * 照合表を作る。長い語を先に試すため、鍵の長さの降順で持つ
 * （「日暮里·舍人线」が「日暮里」に先に食われないようにする）。
 */
export async function buildForeignMap(terms: GlossaryTerm[], field: LangCode): Promise<ForeignEntry[]> {
  const entries: ForeignEntry[] = [];
  const pinyin = isChinese(field) ? await getPinyin() : null;
  if (isChinese(field) && !pinyin) return [];

  for (const t of terms) {
    const term = (t[field] as string | undefined)?.trim();
    if (!term) continue;
    if (isChinese(field)) {
      // 1文字の語は同音が多すぎて誤爆するので対象外にする
      if ([...term].length < 2) continue;
      entries.push({ key: pinyin!(term, { toneType: "none", type: "array" }).join(""), term });
    } else if (isLatin(field)) {
      const key = normalizeLatin(term);
      if (key.length < 3) continue;
      entries.push({ key, term });
    } else {
      // 韓国語・タイ語は表記そのもの
      if (term.length < 2) continue;
      entries.push({ key: term, term });
    }
  }
  return entries.sort((a, b) => b.key.length - a.key.length);
}

/** 中国語：1文字ずつのピンインを見ながら、登録語と同じ音の並びを置き換える。 */
async function correctChinese(text: string, map: ForeignEntry[]): Promise<string> {
  const pinyin = await getPinyin();
  if (!pinyin) return text;
  const chars = [...text];
  const sounds = pinyin(text, { toneType: "none", type: "array" });
  // 念のため：文字数と音の数がずれた場合は触らない（想定外の入力）
  if (sounds.length !== chars.length) return text;

  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    let matched = false;
    for (const { key, term } of map) {
      let acc = "";
      let j = i;
      while (j < chars.length) {
        acc += sounds[j];
        j++;
        if (acc.length > key.length) break;      // 行き過ぎ＝不一致
        if (acc === key) { out.push(term); i = j; matched = true; break; }
        if (!key.startsWith(acc)) break;          // 途中で分岐＝不一致
      }
      if (matched) break;
    }
    if (!matched) { out.push(chars[i]); i++; }
  }
  return out.join("");
}

/** ラテン文字・その他：表記のゆれを吸収して、登録どおりの表記にそろえる。 */
function correctBySpelling(text: string, map: ForeignEntry[], latin: boolean): string {
  let out = text;
  for (const { key, term } of map) {
    if (latin) {
      // 語の区切り（空白・ハイフン）が入っていても拾う。前後が英数字なら語の一部とみなさない
      const flexible = [...key].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s-]*");
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${flexible}(?![A-Za-z0-9])`, "gi"), term);
    } else if (out.includes(key) && !out.includes(term)) {
      out = out.split(key).join(term);
    }
  }
  return out;
}

/**
 * 認識結果を用語集の登録語に寄せる。照合表が空・失敗時はそのまま返す（認識は止めない）。
 */
export async function applyForeignCorrection(
  text: string,
  field: LangCode,
  map: ForeignEntry[],
): Promise<string> {
  if (!text || map.length === 0) return text;
  try {
    if (isChinese(field)) return await correctChinese(text, map);
    return correctBySpelling(text, map, isLatin(field));
  } catch (e) {
    console.error("[stt] 外国語の用語補正でつまずいた（そのまま進める）:", e);
    return text;
  }
}
