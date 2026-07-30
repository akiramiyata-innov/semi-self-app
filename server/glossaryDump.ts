// 用語集オウム返しガード：認識モデルが「用語集のヒント一覧」をそのまま読み上げた形で
// 認識結果を返してくる暴走への対策。
//
// 実測（2026-07-30・登録27語・難読駅名20種×音声2通り×2条件=100回）:
//   お客様は「えっちゅうじままで行きたい」と言っただけなのに、確定テキストが
//   「越中島、東京駅、大鳥居、幡ヶ谷、御徒町、神保町、越中島、半蔵門、荏原町、洗足池、
//     喜多見 SUICA 馬喰横山、千駄ヶ谷、京王稲田堤」
//   になった（50回中1回＝2%。同じ音声を用語集なしで認識させると正しく取れる）。
//   認識モデルへのヒント（inline adaptation）が原因なので、ヒントを使う日本語のときだけ起きる。
//
// 見分け方：この暴走は「登録語と区切り文字だけが並び、助詞や動詞がまったく無い」という
// 明確な特徴を持つ。普通の問い合わせ文は駅名を2つ3つ含んでも必ず助詞や述語が入るため、
// 「登録語以外の文字がほとんど無い」ことを条件にすれば取り違えない。
//
// 破棄した結果は [stt-dump] としてログに残す（無音ゲートと同じ方針）。お客様には何も
// 表示されないが、意味不明な文字列を見せるより良い（係員は聞き直せる。「お客様発話中」の
// 表示も8秒で自動的に消える）。

/** 暴走とみなすのに必要な「異なる登録語」の数。普通の会話で3語以上を助詞なしで並べることはない。 */
export const MIN_TERM_HITS = 4;
/** 登録語・区切り文字以外の文字が全体に占める割合の上限。これを超えれば普通の文とみなす。 */
export const MAX_OTHER_RATIO = 0.2;
/** 区切りとして無視する文字（読点・中黒・空白など）。 */
const SEPARATORS = /[、,・。\s]/;

export interface DumpVerdict {
  /** true = 用語集のオウム返しとみなし破棄する。 */
  isDump: boolean;
  /** 見つかった異なる登録語の数。 */
  hits: number;
  /** 登録語・区切り以外の文字が占める割合（0〜1）。 */
  otherRatio: number;
}

/**
 * 認識結果が「用語集の羅列」かどうかを判定する。
 *
 * 長い語から順に一致させ、一致した範囲は使用済みにして数えるので、
 * 「東京」と「東京駅」のように一方が他方に含まれる登録語を二重に数えない。
 */
export function inspectGlossaryDump(text: string, terms: string[]): DumpVerdict {
  const t = text.trim();
  if (!t || terms.length === 0) return { isDump: false, hits: 0, otherRatio: 1 };

  const used = new Array<boolean>(t.length).fill(false);
  const hit = new Set<string>();
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (!term) continue;
    let from = 0;
    for (;;) {
      const at = t.indexOf(term, from);
      if (at < 0) break;
      // すでに長い語で埋まっている範囲は数えない
      let free = true;
      for (let i = at; i < at + term.length; i++) if (used[i]) { free = false; break; }
      if (free) {
        for (let i = at; i < at + term.length; i++) used[i] = true;
        hit.add(term);
      }
      from = at + 1;
    }
  }

  let other = 0;
  for (let i = 0; i < t.length; i++) {
    if (used[i] || SEPARATORS.test(t[i])) continue;
    other++;
  }
  const otherRatio = other / t.length;
  return { isDump: hit.size >= MIN_TERM_HITS && otherRatio <= MAX_OTHER_RATIO, hits: hit.size, otherRatio };
}
