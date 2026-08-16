import type { LangCode } from "@/lib/socketEvents";

/**
 * 読み上げ用に文章を分ける処理をまとめたもの。
 *
 * socketServer から切り出してあるのは、**言語ごとの区切り方を単体で検証できる**
 * ようにするため（silenceGate.ts / glossaryDump.ts と同じ考え方）。
 */

// Chirp3-HD rejects any single sentence longer than ~300 bytes ("This request
// contains sentences that are too long"). Real staff speech comes from STT with
// no sentence-ending punctuation, so it arrives as one long run-on that trips
// this limit. We split the text into pieces safely under the cap, synthesize
// each, and concatenate the MP3 bytes (which decode fine as one stream).
// Each seam adds ~0.4s of silence, so we split as few times as safely possible
// and cut at word-ish boundaries so that pause lands sensibly, not mid-word.
export const MAX_TTS_BYTES = 250;

type Script = "kanji" | "hira" | "kata" | "other";
function scriptOf(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x4e00 && c <= 0x9fff) return "kanji";
  if (c >= 0x3040 && c <= 0x309f) return "hira";
  if ((c >= 0x30a0 && c <= 0x30ff) || (c >= 0xff66 && c <= 0xff9d)) return "kata";
  return "other";
}

/**
 * 文の切れ目で分ける（v1.43.0「文ごとの先行再生」用）。
 *
 * ★言語ごとに文の終わり方が違う:
 *  - 日本語・中国語（簡体/繁体）… `。！？`（全角）で終わる
 *  - 英語・韓国語・フランス語・スペイン語 … `. ! ?` のうしろに空白が続くとき。
 *    空白を条件にするのは「1.5」のような小数や、数字に続く記号で切らないため
 *  - タイ語 … **文の終わりを示す記号が無い**。空白が文・句の切れ目なのでそこで切る
 *    （これを入れないと、区切りが1つも見つからず文字数だけで機械的に切られ、
 *      実測で「รายการ」が「รายกา」と「ร」に割れていた）
 *
 * 区切りは前の断片に付けたまま残すので、つなぎ直すと元の文に戻る。
 */
export function splitIntoSentences(text: string, langCode: LangCode): string[] {
  if (langCode === "th") return text.split(/(?<=\s)/).filter(Boolean);
  return text.split(/(?<=[。！？])|(?<=[.!?]\s)/).filter(Boolean);
}

/**
 * これ以下の長さなら文で分けない。合成は1秒もかからないので、分けても始まりは
 * 早くならず、つなぎ目の無音（約0.4秒）だけが増えて損になる。
 */
const NO_SPLIT_BYTES = 120;
/**
 * 1つ目の断片の最低の長さ。**ここは短いほど早く話し始められる**ので小さくする。
 */
const MIN_FIRST_PIECE_BYTES = 30;
/**
 * タイ語だけ1つ目を長めにとる。
 *
 * 他の言語は「文の終わり」で切るので、どれだけ短くても文として成立する。
 * タイ語には文の終わりを示す記号が無く**単語の区切り（空白）で切る**ため、
 * 短くしすぎると文の途中で間が空く（実測: 30バイトだと「日暮里までの運賃は」で
 * 切れて「150バーツ」の前で止まってしまう）。区切りが句の切れ目に落ちる長さにする。
 */
const MIN_FIRST_PIECE_BYTES_TH = 90;
/**
 * 2つ目以降の最低の長さ。1つ目を読み上げている間に作れるので急ぐ必要がなく、
 * まとめて長めにしてつなぎ目（無音）の数を減らす。
 */
const MIN_NEXT_PIECE_BYTES = 120;
/** 最後に余った短い断片は、前の断片にくっつける（つなぎ目を1つ減らす）。 */
const MERGE_TAIL_UNDER_BYTES = 40;

/**
 * 読み上げを「文の順に、できたものから」流すための分け方（C-2）。
 *
 * 従来は全文を合成し終えてから話し始めていたため、長い案内ほど待たされた
 * （実測: 101字で3.5秒）。1文目だけ先に作って話し始め、その間に残りを作る。
 */
export function splitForSpeech(text: string, langCode: LangCode): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (Buffer.byteLength(clean) <= NO_SPLIT_BYTES) return splitForTts(clean);

  const firstMin = langCode === "th" ? MIN_FIRST_PIECE_BYTES_TH : MIN_FIRST_PIECE_BYTES;
  const pieces: string[] = [];
  let buf = "";
  for (const sentence of splitIntoSentences(clean, langCode)) {
    buf += sentence;
    const need = pieces.length === 0 ? firstMin : MIN_NEXT_PIECE_BYTES;
    if (Buffer.byteLength(buf) >= need) { pieces.push(buf); buf = ""; }
  }
  if (buf.trim()) {
    if (pieces.length && Buffer.byteLength(buf) < MERGE_TAIL_UNDER_BYTES) pieces[pieces.length - 1] += buf;
    else pieces.push(buf);
  }
  // 1つ1つが合成の上限を超える場合は、従来どおりさらに細かく分ける
  return pieces.flatMap((p) => splitForTts(p));
}

/** Split text into pieces each ≤ MAX_TTS_BYTES, preferring natural breaks. */
export function splitForTts(text: string): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (Buffer.byteLength(clean) <= MAX_TTS_BYTES) return [clean];

  // Break after sentence/clause punctuation, keeping the delimiter with its piece.
  const units = clean.split(/(?<=[。．！？!?、,\n])/);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => { const t = buf.trim(); if (t) chunks.push(t); buf = ""; };

  for (let unit of units) {
    // A punctuation-free unit can exceed the cap. Split it, cutting just before a
    // hiragana→kanji/katakana transition (usually a word start) near the target so
    // the seam pause lands at a word boundary instead of mid-word. Fall back to a
    // plain length cut when no such boundary is in range.
    while (Buffer.byteLength(unit) > MAX_TTS_BYTES) {
      let hardCut = unit.length;
      while (hardCut > 1 && Buffer.byteLength(unit.slice(0, hardCut)) > MAX_TTS_BYTES) hardCut--;
      let cut = hardCut;
      const minCut = Math.floor(hardCut * 0.6);
      for (let i = hardCut; i > minCut; i--) {
        if (scriptOf(unit[i - 1]) === "hira" && (scriptOf(unit[i]) === "kanji" || scriptOf(unit[i]) === "kata")) {
          cut = i;
          break;
        }
      }
      flush();
      chunks.push(unit.slice(0, cut));
      unit = unit.slice(cut);
    }
    if (Buffer.byteLength(buf + unit) > MAX_TTS_BYTES) flush();
    buf += unit;
  }
  flush();
  return chunks;
}

