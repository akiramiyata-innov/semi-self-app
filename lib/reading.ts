import type { Tokenizer, IpadicFeatures } from "kuromoji";
import { join } from "path";
import type { GlossaryTerm } from "./types";

// 読み照合による用語補正。chirp_2 は音は正しく取れても、同音の別漢字で書き出すこと
// がある（例: 用賀→洋画）。カナ→漢字の単純置換では拾えないので、認識結果を形態素
// 解析して各語の「読み」を取り、登録語の読みと一致する連続トークンを漢字へ置換する。
//
// kuromoji（辞書ファイル込み）は初回のみ遅延ロードするので、streaming を使わない
// 限りロードされない。ロード失敗時は補正をスキップ（STT は止めない）。

let tokenizerPromise: Promise<Tokenizer<IpadicFeatures>> | null = null;

function getTokenizer(): Promise<Tokenizer<IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      const imported = await import("kuromoji");
      // CJS 相互運用: builder は名前空間直下か .default 下にある
      const km = (imported as unknown as { default?: typeof imported }).default ?? imported;
      const dicPath = join(process.cwd(), "node_modules", "kuromoji", "dict");
      return await new Promise<Tokenizer<IpadicFeatures>>((resolve, reject) => {
        km.builder({ dicPath }).build((err, tokenizer) => {
          if (err) reject(err);
          else resolve(tokenizer);
        });
      });
    })();
  }
  return tokenizerPromise;
}

/** 辞書ロード（約1〜2秒）を先に始めて、最初の認識結果までに準備が整うようにする。 */
export function warmUpTokenizer(): void {
  getTokenizer().catch(() => { tokenizerPromise = null; });
}

const KANA_OFFSET = 0x60;
function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + KANA_OFFSET));
}

// 地名によくある接尾辞漢字とその読み。読み方が一通りでない（町＝チョウ/マチ）ため、
// 用語集の登録よみと形態素解析の読みが末尾だけ食い違うことがある。
export const SUFFIX_KANJI: Array<{ kanji: string; readings: string[] }> = [
  { kanji: "町", readings: ["ちょう", "まち"] },
  { kanji: "駅", readings: ["えき"] },
  { kanji: "線", readings: ["せん"] },
  { kanji: "川", readings: ["がわ", "かわ"] },
  { kanji: "山", readings: ["やま", "ざん", "さん"] },
  { kanji: "台", readings: ["だい"] },
  { kanji: "谷", readings: ["がや", "や", "たに", "だに"] },
  { kanji: "前", readings: ["まえ"] },
  { kanji: "田", readings: ["だ", "た"] },
  { kanji: "坂", readings: ["さか", "ざか"] },
  { kanji: "沢", readings: ["さわ", "ざわ"] },
  { kanji: "原", readings: ["はら", "ばら"] },
  { kanji: "塚", readings: ["つか", "づか"] },
  { kanji: "島", readings: ["じま", "しま"] },
  { kanji: "口", readings: ["ぐち", "くち"] },
  { kanji: "橋", readings: ["ばし", "はし"] },
  { kanji: "園", readings: ["えん"] },
  { kanji: "寺", readings: ["でら", "じ"] },
  { kanji: "里", readings: ["さと", "り"] },
  { kanji: "区", readings: ["く"] },
  { kanji: "市", readings: ["し"] },
];

export type ReadingEntry = { readings: string[]; kanji: string };

/**
 * 照合に使う読みの候補（カタカナ）。末尾が接尾辞漢字の語は、解析器が登録よみと違う
 * 読みを付けることがある（狸穴町: 登録=マミアナチョウ ／ 解析=マミアナマチ）ので、
 * 接尾辞の別読みに差し替えた形も候補に加える。
 */
function readingVariants(ja: string, base: string): string[] {
  const set = new Set<string>([base]);
  for (const suf of SUFFIX_KANJI) {
    if (!ja.endsWith(suf.kanji)) continue;
    const readings = suf.readings.map(toKatakana);
    for (const r of readings) {
      if (!base.endsWith(r) || base.length <= r.length) continue;
      const stem = base.slice(0, -r.length);
      for (const alt of readings) set.add(stem + alt);
    }
  }
  return [...set];
}

const longestOf = (e: ReadingEntry): number => Math.max(...e.readings.map((r) => r.length));

/** { 読み(カタカナ) → 漢字 }。長い読みを優先するため長さ降順で保持する。 */
export function buildReadingMap(terms: GlossaryTerm[]): ReadingEntry[] {
  const map: ReadingEntry[] = [];
  for (const t of terms) {
    const yomi = t.yomi?.trim();
    const ja = t.ja?.trim();
    if (!yomi || !ja) continue;
    map.push({ readings: readingVariants(ja, toKatakana(yomi)), kanji: ja });
  }
  return map.sort((a, b) => longestOf(b) - longestOf(a));
}

/**
 * 認識結果を形態素解析し、登録語の読みと一致する連続トークン列を漢字へ置換する。
 * トークナイザ未準備・失敗時はそのまま返す（STT を止めない）。
 */
export async function applyReadingMatch(text: string, map: ReadingEntry[]): Promise<string> {
  if (!text || map.length === 0) return text;
  let tokenizer: Tokenizer<IpadicFeatures>;
  try {
    tokenizer = await getTokenizer();
  } catch {
    return text;
  }
  const tokens = tokenizer.tokenize(text);
  const readingOf = (t: IpadicFeatures): string =>
    t.reading && t.reading !== "*" ? t.reading : toKatakana(t.surface_form);

  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const entry of map) {
      const { readings, kanji } = entry;
      const longest = longestOf(entry);
      let acc = "";
      let j = i;
      while (j < tokens.length) {
        acc += readingOf(tokens[j]);
        j++;
        if (acc.length > longest) break; // 行き過ぎ＝不一致
        if (readings.includes(acc)) { out.push(kanji); i = j; matched = true; break; }
        if (!readings.some((r) => r.startsWith(acc))) break; // 途中で分岐＝不一致
      }
      if (matched) break;
    }
    if (!matched) { out.push(tokens[i].surface_form); i++; }
  }
  return out.join("");
}
