import type { TranscriptEntry } from "./types";

/**
 * 会話の並び順（v1.52.0）。
 *
 * 発言は「確定した順」ではなく「**話し始めた順**」に並べる。確定までの遅れは話し手で
 * 違う（係員はマイクを離すと0.85秒、お客様は常時ONで1.5〜2秒＋翻訳）ため、確定順だと
 * 先に話したお客様の発言が、あとから返した係員の返事の下に出てしまう（2026-08-21
 * 英語S5の「順番の逆転」）。
 *
 * この並べ方はサーバーの通話記録・係員画面・お客様画面の3か所で共通に使う。
 * 3か所が同じ規則で並べることで、どこを見ても同じ順番になる。
 */

/** 並び順に使う時刻＝話し始め。無ければ届いた時刻で代用する。 */
export function orderAt(e: Pick<TranscriptEntry, "spokeAt" | "timestamp">): number {
  return e.spokeAt ?? e.timestamp;
}

export interface InsertResult {
  /** 差し込んだあとの一覧（新しい配列。元の配列は変えない） */
  list: TranscriptEntry[];
  /** 差し込んだ位置 */
  index: number;
  /** 新たに「確定前の返答」の印を付けた係員の発言の id */
  marked: string[];
}

/**
 * 発言を「話し始めの時刻」の順に差し込む。
 *
 * - 同じ時刻なら、あとから来たほうを後ろに置く（同じ話し手の発言の前後が崩れない）
 * - お客様の発言を**既にある係員の返答より上に**差し込んだときは、その直後に並ぶ係員の
 *   返答（次のお客様の発言まで）に「確定前の返答」の印（earlyReply）を付ける。
 *   係員はその発言をまだ見ないうちに答えていたことになるため。
 * - 差し込みが末尾（＝これまでどおりの追加）なら印は付かない
 */
export function insertByOrder(list: TranscriptEntry[], entry: TranscriptEntry): InsertResult {
  const at = orderAt(entry);
  let index = list.length;
  while (index > 0 && orderAt(list[index - 1]) > at) index--;
  const next = list.slice();
  next.splice(index, 0, entry);
  const marked: string[] = [];
  if (entry.speaker === "user" && entry.isFinal) {
    // お客様の発言を差し込んだ: 直後に並ぶ係員の返答（次のお客様の発言まで）は、
    // この発言が届く前に行われた返答
    for (let i = index + 1; i < next.length; i++) {
      const e = next[i];
      if (e.speaker !== "staff") break; // 次のお客様の発言より後ろは、その発言への返答
      if (!e.isFinal || e.earlyReply) continue;
      next[i] = { ...e, earlyReply: true };
      marked.push(e.id);
    }
  } else if (entry.speaker === "staff" && entry.isFinal && !entry.earlyReply) {
    // 係員の返答を差し込んだ: サーバーは読み上げが終わってから記録するため、先に
    // 話し始めたお客様の発言のほうが**先に記録されている**ことがある。並びで直前の
    // お客様の発言が、この返答の時刻（timestamp＝受け取った時刻）より後に届いて
    // いれば、係員はその発言を見ずに答えている＝確定前の返答
    for (let i = index - 1; i >= 0; i--) {
      const e = next[i];
      if (e.speaker !== "user" || !e.isFinal) continue;
      if (e.timestamp > entry.timestamp) {
        next[index] = { ...entry, earlyReply: true };
        marked.push(entry.id);
      }
      break;
    }
  }
  return { list: next, index, marked };
}
