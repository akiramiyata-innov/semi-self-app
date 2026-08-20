import type { Socket } from "socket.io";
import type { v2 } from "@google-cloud/speech";
import { getSpeechClient, RECOGNIZER, SPEECH_MODEL } from "../lib/speechClient";
import {
  glossaryFieldOf, buildForeignMap, applyForeignCorrection, warmUpPinyin,
  type ForeignEntry,
} from "../lib/foreignReading";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import type { GlossaryTerm } from "../lib/types";
import { buildReadingMap, applyReadingMatch, warmUpTokenizer, SUFFIX_KANJI, type ReadingEntry } from "../lib/reading";
import { noteSttSpeech, noteSttFinal } from "./metrics";
import { SilenceGate, chunkRms, SPEECH_RMS, MIN_SPEECH_CHUNKS } from "./silenceGate";
import { inspectGlossaryDump } from "./glossaryDump";
import { recordSocketError } from "./errorLog";

// Google streaming recognition has a per-stream time limit. Reopen the stream
// before then so long (2 min+) speech continues seamlessly.
const STREAM_RESTART_MS = 4.5 * 60 * 1000;
/**
 * 用語集の語を「出やすくする」後押し（adaptation）の強さ。V2 の上限は 20。
 * **0 = ヒントを送らない**（かな→漢字の後処理・読み照合は用語集から作られ、そのまま効く）。
 *
 * ★既定を 20 → 0 に変更（2026-08-16 の実測にもとづく）。
 * 基本性能テスト（日本語S5/S8）で「狸穴町→麻布十番」「舎人ライナー→狸ライナー」
 * 「追加で→SUICAで」と、**登録語が別の言葉を乗っ取る誤認識**が多発。同一音声162本の
 * 厳密A/B（後押し 20/5/0 × クリーン・実マイク相当の劣化音声 × 2声）で測った結果:
 *   - 後押し 20 と 5 は結果が完全同一（強さの調整では副作用が消えない・2026-07-30と同結論）
 *   - 劣化音声の正解率: 後押しあり 61% ／ **なし 78%**
 *   - 乗っ取り: 後押しあり 8件（麻布十番×4・SUICA×4）／ なし 2件（SUICA×2
 *     ＝「ついか」と「すいか」の聞き間違いで、後押しとは無関係に残る分）
 *   - 実害の「狸穴町→麻布十番」「舎人ライナー→狸ライナー」「舎人→こねり」は
 *     **後押しを切ると全て正しく認識**された（難読地名は後処理が漢字化を担う）
 * つまり現状の16語では、モデルへのヒントは「助ける」より「乗っ取る」が上回る。
 * 用語集そのものは後処理・読み照合・訳語固定で引き続き使われる。
 */
const BOOST = Number(process.env.STT_ADAPTATION_BOOST ?? "0");
/**
 * 外国語の後押しの強さ（施策3・2026-08-18）。日本語とは別に持つ。
 *
 * ★日本語は後押しを切ったほうが良かった（乗っ取りが増えるため・v1.40.0）が、
 * **中国語は正反対で、後押しを入れないとほとんど当たらない**。
 *
 * 実測（2026-08-18・用語集の中国語表記30語をヒントに、TTS音声＋実マイク相当の
 * 劣化音声の2条件・登録語を含む文6件と含まない文5件）:
 *   後押し 0 … 登録語の正解 **0/6**・乗っ取り 0/5
 *   後押し 5 … 登録語の正解 **4/6**・乗っ取り 0/5
 *   後押し10 … 4/6・乗っ取り 0/5（5と同結果）
 *   後押し20 … 4/6・乗っ取り 0/5（5と同結果）
 * きれいな音声でも劣化音声でも同じ傾向。**日本語で問題になった「乗っ取り」は
 * 中国語では1件も起きなかった**（登録語を含まない文に登録語が紛れ込まない）。
 * 5・10・20 が同結果なので、**将来語数が増えたときの乗っ取りの危険がいちばん
 * 小さい 5 を既定**にする。日本語は従来どおり 0（上の BOOST）。
 */
const BOOST_FOREIGN = Number(process.env.STT_ADAPTATION_BOOST_FOREIGN ?? "5");

/**
 * 「話し終わった」と判定するまでの無音の長さ（ミリ秒）。0＝指定せず Google の既定に任せる。
 *
 * ★話し終えてから文字が確定するまでの待ち時間は、実測で約1.4〜1.6秒（2026-08-19 本番）。
 *   その大半がこの判定待ちで、1往復に2回（係員側とお客様側）効いてくる。
 * ★短くすると速くなるが、間を取って話す人の言葉が途中で切られる。
 *   速さと切れやすさの両方を実測してから決めること。既定は現状維持（0＝指定しない）。
 */
const SPEECH_END_TIMEOUT_MS = Number(process.env.STT_SPEECH_END_TIMEOUT_MS ?? "0");

/**
 * 音声認識（chirp_2）に渡す言語コードの読み替え表。
 *
 * ★中国語だけは `zh-CN` / `zh-TW` が**拒否される**。実測のエラー:
 *   `INVALID_ARGUMENT: The language "zh-CN" is not supported by the model
 *    "chirp_2" in the location named "asia-northeast1"`
 *   chirp_2 は「話し言葉＋文字体系＋地域」の表記を求めるため、
 *   簡体は cmn-Hans-CN、繁体は cmn-Hant-TW を使う（受理を実測で確認）。
 *   他の6言語（ja/en/ko/fr/es/th）は bcp47 のままで通る。
 *
 * ★`lib/languages.ts` の bcp47 を書き換えないのは、そちらが
 *   **Web Speech 版の音声認識**でも使われており、あちらは zh-CN / zh-TW を
 *   要求するため。読み替えはこの1か所に閉じ込める。
 *
 * これを入れるまで、中国語を選んだお客様は**マイクが必ずエラーになり
 * 一言も届かなかった**（2026-08-17 の中国語テスト開始時に判明。日本語・英語しか
 * 実機で試していなかったため気づけていなかった）。
 */
const STT_LANGUAGE_ALIAS: Record<string, string> = {
  "zh-CN": "cmn-Hans-CN",
  "zh-TW": "cmn-Hant-TW",
};
function sttLanguageCode(lang: string): string {
  const code = lang || "ja-JP";
  return STT_LANGUAGE_ALIAS[code] ?? code;
}
// 幻聴対策の第3層: モデル自身の「自信度」が低い確定は破棄する。
// 無音ゲート（音量）では、ささやき・息・衣擦れのような「続く音」を本物の小声と
// 区別できない（小声を守るため通すしかない）。その先の見分けは内容側で行う。
// 実測（2026-08-03・chirp_2・TTS音声）: 実発話はほぼ聞こえない音量(3%)でも 0.91〜0.97、
// 雑音からの創作は 0.67〜0.88（0.88は用語集オウム返し型＝別ガードが破棄。すり抜ける
// 「登録語の引き寄せ」型が 0.67）。
//
// ★2026-08-04 に本番の物音テストで実際にすり抜けかけた値が出た: 0.661 と **0.739**。
// 旧しきい値 0.75 との差はわずか 0.011 で、あと少し高ければ「舎人ライナー乗り越し精算」が
// お客様の画面に出ていた。そこで 0.80 へ引き上げ、余裕を 0.011 → 0.061 に広げた。
//
// **0.85 ではなく 0.80 を選んだ理由**: 上げすぎると本物の発話を捨てる側の事故になる。
// 実発話の 0.91〜0.97 は静かな場所での実測で、**騒音下（駅のホーム等）の実発話の
// 自信度はまだ測れていない**。騒音下では下がるはずなので、本物側にはできるだけ余裕を
// 残す。0.80 なら幻聴側に 0.061・本物側に 0.11 の余裕があり、危険の大きい「本物を
// 捨てる」側を厚くできる。基本性能テストで [stt-diag] の conf= を集めたら見直す。
const MIN_CONFIDENCE = Number(process.env.STT_MIN_CONFIDENCE ?? "0.80");

/**
 * ★2026-08-14 の基本性能テスト（英語8通話）で 0.80 の根拠が崩れたため、音量と
 * 組み合わせた二段構えにした。
 *
 * **測ってわかったこと**（Railwayログの全量。採用158件・自信度で破棄9件）:
 * - 採用された本物の自信度は 英語 n=82 で最小 **0.837**、日本語 n=76 で最小 **0.814**。
 *   つまり 0.80 は「本物の下限のすぐ下」に貼り付いており、余裕がまったく無かった。
 * - 自信度で破棄した9件のうち **8件が本物**（0.394〜0.800。例:「okay from which track
 *   do the sinjuku line trains depart」0.774 が丸ごと消え、会話が混乱した）。
 *   明らかな幻聴は「wah」0.091 の1件だけ。
 * - 一方 **本物158件は例外なく maxRms≥1059 かつ発話チャンク≥5（0.5秒）**だった
 *   （中央値は maxRms 6887・30チャンク）。音量と長さは自信度よりはっきり分かれる。
 *
 * そこで「明らかに人の声」と言える音量と長さがあれば、聞き取りにくくて自信度が
 * 低い確定でも通す。ささやき・息・衣擦れ・単発の物音（＝自信度ガードが本来ねらう
 * 相手）はこの条件を満たさないので、そちらには従来どおり 0.80 を課す。
 *
 * **残る危険と、その見張り方**: 2026-08-04 の物音テストでは幻聴が 0.661・0.739 を
 * 出している。0.5秒以上続く大音量の物音であればすり抜けうる。次の測定で判断できるよう、
 * 破棄・採用の両方のログに maxRms と発話チャンク数を残してある（[stt-conf]/[stt-diag]）。
 */
const CLEAR_VOICE_RMS = Number(process.env.STT_CLEAR_VOICE_RMS ?? "1000");
const CLEAR_VOICE_CHUNKS = Number(process.env.STT_CLEAR_VOICE_CHUNKS ?? "5");
/** 「明らかに人の声」だったときの自信度しきい値。 */
const MIN_CONFIDENCE_CLEAR = Number(process.env.STT_MIN_CONFIDENCE_CLEAR ?? "0.50");
/**
 * 分割確定の引き継ぎ分にも「明らかな声」の緩い基準を使ってよい最短の文字数
 * （約物・空白を除いて数える）。
 *
 * ★経緯（2つの実害の板挟みを、文の長さで切り分ける）:
 * - 2026-08-14 日本語S8: 引き継ぎ分に無条件で緩い基準を使うと、本物の発話の直後に
 *   モデルが幻聴した**短い相づち（「はい」「うん」）**が「続き」として素通りした。
 *   → v1.38.0 で引き継ぎ分は常に厳しい基準(0.80)へ。
 * - 2026-08-16 日本語S5: その厳しさが本物を捨てた。「出口を出た後はどちらに
 *   向かえばいいですか」が分割され、**後半「に向かえばいいですか」(10文字)が
 *   自信度0.773で破棄**＝会話から欠落した（引き継いだ音量は maxRms=4766・36コマと
 *   十分だったのに、引き継ぎというだけで 0.80 を課していた）。
 *
 * 幻聴の相づちは1〜4文字（はい・うん・はいはい）、本物の言い残しはそれより長い文が
 * ほとんど。そこで「引き継ぎでも、この文字数以上なら音量の裏付けを認める」とする。
 * 5文字未満の本物の続き（「はい」等）は厳しい基準のままだが、実測で本物の自信度は
 * 0.814以上なので生き残る。
 */
const CONT_CLEAR_MIN_CHARS = Number(process.env.STT_CONT_CLEAR_MIN_CHARS ?? "5");

/** 約物・空白を除いた「中身の文字数」。分割確定の長さ判定に使う。 */
export function coreLength(text: string): number {
  return text.replace(/[\s、。,.．・？?！!]/g, "").length;
}

/**
 * 「明らかに人の声」として緩い自信度基準(0.50)を使ってよいか。
 * 音量と長さの裏付け（maxRms≥1000・発話0.5秒以上）が前提。分割確定の引き継ぎ分は、
 * その裏付けが**前の発話のもの**なので、文字数が十分な文（＝幻聴の相づちではない）に
 * 限って認める。単体テストできるよう純関数として公開している。
 */
export function clearVoiceEligible(
  verdict: { continuation?: boolean; maxRms: number; speechChunks: number },
  coreLen: number,
  minContChars = CONT_CLEAR_MIN_CHARS,
): boolean {
  if (verdict.maxRms < CLEAR_VOICE_RMS || verdict.speechChunks < CLEAR_VOICE_CHUNKS) return false;
  if (!verdict.continuation) return true;
  return coreLen >= minContChars;
}

type SpeechStream = ReturnType<v2.SpeechClient["_streamingRecognize"]>;

/** Minimal shape of a V2 StreamingRecognizeResponse we consume. */
interface StreamingResult {
  results?: Array<{
    isFinal?: boolean | null;
    alternatives?: Array<{ transcript?: string | null; confidence?: number | null }> | null;
  }> | null;
}

const KANA_OFFSET = 0x60; // ひらがな→カタカナのコードポイント差
function toKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + KANA_OFFSET));
}
function toHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - KANA_OFFSET));
}

/** { カナ読み等 → 漢字 } の置換ペア。長い形を先に置換するため長さ降順で保持する。 */
type Correction = { from: string; to: string };
function buildCorrections(terms: GlossaryTerm[]): Correction[] {
  const list: Correction[] = [];
  for (const t of terms) {
    const yomi = t.yomi?.trim();
    const ja = t.ja?.trim();
    if (!yomi || !ja) continue;
    const forms = new Set<string>([yomi]); // 全かな読み
    // 末尾が一般的な接尾辞漢字（町/駅/川…）で読みもその読みで終わる語は、STTが
    // 「語幹の読み＋接尾辞漢字」で出しうる（例: 狸穴町→まみあな町）。その形も対象に。
    for (const suf of SUFFIX_KANJI) {
      if (!ja.endsWith(suf.kanji)) continue;
      for (const r of suf.readings) {
        if (yomi.endsWith(r) && yomi.length > r.length) {
          forms.add(yomi.slice(0, -r.length) + suf.kanji);
        }
      }
    }
    // chirp_2 は読みをひらがな／カタカナどちらでも出しうるので両形を登録
    for (const form of forms) {
      const hira = toHiragana(form);
      const kata = toKatakana(form);
      list.push({ from: hira, to: ja });
      if (kata !== hira) list.push({ from: kata, to: ja });
    }
  }
  return list.sort((a, b) => b.from.length - a.from.length);
}

/**
 * 英字を含む登録語の「表記ゆれ（大文字小文字）」を登録どおりに揃える規則。
 *
 * chirp_2 は同じ音でも書き方が揺れる（「スイカ」→ カタカナのことも suica と英字小文字の
 * こともある）。カナで出れば読みの置換で登録表記になるが、英字で出た場合は読みの照合対象に
 * ならず素通りしていた。そこで英字表記も登録どおりに揃える。翻訳の用語集は大文字小文字を
 * 区別して照合するため、ここで揃えておくと訳語の固定も正しく効くようになる。
 */
type CaseRule = { re: RegExp; to: string };
function buildCaseRules(terms: GlossaryTerm[]): CaseRule[] {
  const rules: CaseRule[] = [];
  for (const t of terms) {
    const ja = t.ja?.trim();
    if (!ja || !/[A-Za-z]/.test(ja)) continue; // 英字を含む登録語だけが対象
    const escaped = ja.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 単語の区切りでのみ一致させる（"basic" の一部など、語の内部では反応させない）
    rules.push({ re: new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi"), to: ja });
  }
  return rules;
}

/**
 * 連番・繰り返しの「暴走出力」判定。ノイズを与えると chirp 系は「1234567891011…」の
 * ような同種の文字の羅列を出すことがある（実測: 息・衣擦れ風ノイズから数字177文字の
 * 連番が自信度0.98で出た＝自信度ガードでは捕まらない）。
 *
 * ★2026-08-11 全面見直し。旧判定は「約物・空白を除いて20文字以上なのに文字種が
 * 10種以下」の一本だったが、これは文字の種類が数千ある日本語を前提にした基準で、
 * **26文字しかないアルファベットの言語では普通の文が該当してしまう**。実機の
 * 「マイクONなのに認識されない（特に外国語）」の主因（実測: "i want to see the
 * station"=20文字9種 / "es este el tren correcto"=20文字8種 が破棄。逆に
 * "yes yes yes yes yes yes" は空白除去で18文字となり20文字に届かず素通り＝
 * 取り逃しも起きていた）。言語の型で判定を分ける:
 *
 * - 空白で単語を区切る言語（英・仏・西・韓など）＝空白を含むテキストは、
 *   「同じ単語の繰り返し率」で判定する（6語以上で異なり語が1/3未満なら暴走。
 *   "yes yes yes yes yes yes"=6語1種→破棄 / "thank you thank you thank you"
 *   =6語2種でちょうど1/3→通す）。単語の中に紛れた数字連番などの塊は、
 *   その塊だけを旧基準（20文字以上かつ10種以下）で見る。
 * - 空白を使わない言語（日・中・タイ）＝空白を含まないテキストは従来どおり
 *   （20文字以上かつ文字種10種以下。数字の連番＝文字種は最大10種、
 *   普通の20文字の日本語文は17種前後なので発話は締め出されない）。
 */
export function isDegenerateRun(text: string): boolean {
  const cleaned = text.replace(/[、。,.．・？?！!]/g, " ").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    // 空白で区切る言語: 文字種では判定しない（アルファベットは種類が少なすぎる）
    if (tokens.length >= 6) {
      const unique = new Set(tokens.map((t) => t.toLowerCase())).size;
      if (unique / tokens.length < 1 / 3) return true; // 同じ語の羅列＝暴走
    }
    // 語の中に埋まった連番の塊（例: "料金は 1234567891011121314 です"）
    return tokens.some((t) => t.length >= 20 && new Set(t).size <= 10);
  }
  // 空白を使わない言語・連続した羅列: 従来判定
  const core = cleaned.replace(/\s/g, "");
  if (core.length < 20) return false;
  return new Set(core).size <= 10;
}

/**
 * Registers per-socket streaming STT (Speech-to-Text **V2**, chirp_2 model). The
 * client sends `stt:start` then raw 16kHz mono PCM chunks via `stt:audio`, and
 * receives `stt:interim` / `stt:final` transcripts in real time. `stt:stop` (or
 * disconnect) ends it. Registered glossary terms are passed as inline model
 * adaptation so domain words (station names, jargon) are recognized correctly —
 * this is what the classic V1 phrase hints failed to do.
 */
export function registerSttHandlers(
  socket: Socket,
  onVoiceActivity?: () => void,
  /**
   * ゲートを通った途中経過（interim）が出たときに呼ばれる。
   *
   * ★2026-08-14 の基本性能テストで「係員がお客様の発話にかぶせて話してしまう」が
   * 多発した対策。係員には確定テキストしか届かず、お客様が話し終えてから確定が出る
   * までの約2秒間、話したことすら分からなかった。途中経過は無音ゲートを通った
   * 「実際に声がある」証拠なので、これを合図に係員画面へ流す。
   */
  onInterim?: (transcript: string) => void,
  /**
   * お客様から届いた音声のかたまりをそのまま渡す（v1.42.0「お客様の声を聞く」）。
   *
   * 係員が担当の通話で「お客様の声」をONにしているときだけ、担当係員の画面へ
   * 中継して鳴らす。**認識の流れには手を触れず、横からコピーを渡すだけ**なので、
   * ここで何が起きても文字起こしは従来どおり動く（呼び出しは try で囲ってある）。
   */
  onAudio?: (chunk: Buffer) => void,
): void {
  let stream: SpeechStream | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let lang = "ja-JP";
  let phrases: string[] = [];
  let corrections: Correction[] = [];
  let caseRules: CaseRule[] = [];
  let readingMap: ReadingEntry[] = [];
  /** 外国語の用語照合表（施策2）。日本語の通話では空のまま。 */
  let foreignMap: ForeignEntry[] = [];
  /** この通話の言語が使う用語集の欄（日本語なら null）。 */
  let glossaryField: ReturnType<typeof glossaryFieldOf> = null;
  let running = false;
  let consecutiveErrors = 0;
  // 通話終了時の拾い上げ（flushPendingFinal）中だけ、確定テキストをここへも回収する
  let flushCollector: ((transcript: string) => void) | null = null;
  // 無音ゲート：発話音量が観測されていない区間の認識結果（モデルの幻聴）を破棄する
  const gate = new SilenceGate();
  // 認識ガードの障害履歴への記録は種類ごとに1分に1件へ間引く。マイク常時ON方式では
  // 待ち時間の雑音でガードが頻繁に作動しうるため、そのまま記録すると障害履歴
  // （最新500件）が埋まり、本物の障害記録が押し出されてしまう。抑えた回数は
  // 次に記録するとき件数として書き添える（consoleログは全件そのまま出す）。
  const GUARD_RECORD_INTERVAL_MS = 60_000;
  const guardRecordLast = new Map<string, { at: number; suppressed: number }>();
  const recordGuard = (type: string, detail: string) => {
    const now = Date.now();
    const prev = guardRecordLast.get(type);
    if (prev && now - prev.at < GUARD_RECORD_INTERVAL_MS) {
      prev.suppressed++;
      return;
    }
    const extra = prev?.suppressed ? `（ほかに直近の間引きで${prev.suppressed}回）` : "";
    guardRecordLast.set(type, { at: now, suppressed: 0 });
    recordSocketError(socket.id, { type, detail: detail + extra });
  };
  // 「お客様発話中」表示用：発話音量が連続したチャンク数（0.2秒＝2チャンク続いたら通知）
  let voiceRun = 0;
  /**
   * マイクON直後は「発話中」の通知を出さない猶予。
   *
   * ★2026-08-14 の基本性能テストで「通話開始と同時に、誰も話していないのに
   * 『お客様発話中』が点く」が観察された。通話成立と同時にマイクが自動でONになり、
   * 起動直後の機器音・音量の自動調整のゆらぎを声と数えてしまうため。
   * 猶予の間も音声認識そのものは全チャンクを送っている（表示の判定だけを待たせる）。
   */
  const VOICE_BADGE_WARMUP_MS = Number(process.env.STT_VOICE_BADGE_WARMUP_MS ?? "1000");
  let micStartedAt = 0;
  /**
   * ストリームが開くまでの音声を貯めておく置き場。
   *
   * **マイクONの直後に話し始めると、話し出しが欠けていた**（実測: 「馬喰横山まで…」が
   * 「黒横山まで…」になる）。stt:start を受けてから Google のストリームが開くまでには
   * 用語集の取得やストリームの確立で待ち時間があり、その間に届いた音声を捨てていたため。
   * 捨てずに貯めておき、開いた直後に先頭から流し込む。
   */
  let pendingAudio: Buffer[] = [];
  /** 貯める上限（100チャンク＝10秒）。異常時にメモリを食い続けないための歯止め。 */
  const PENDING_MAX = 100;

  /** 認識結果のカナ読みを、登録された漢字に置き換える（chirp_2 が漢字化しきれない語の後処理）。 */
  function applyCorrections(text: string): string {
    let out = text;
    for (const c of corrections) {
      if (out.includes(c.from)) out = out.split(c.from).join(c.to);
    }
    // 英字で出た登録語（suica / Suica）を登録どおりの表記（SUICA）に揃える
    for (const r of caseRules) out = out.replace(r.re, r.to);
    return out;
  }

  async function openStream(): Promise<void> {
    const client = await getSpeechClient();
    if (!client) {
      socket.emit("stt:error", { message: "STT unavailable (no credentials)" });
      return;
    }
    // 既存ストリームが残っていたら先に閉じる。多重 stt:start（マイクの素早いON/OFF等）で
    // 古いストリームがリークすると、音声が届かないままGoogleが
    // "Stream timed out after receiving no more client requests" でタイムアウトする。
    const prev = stream;
    stream = null;
    try { prev?.end(); } catch { /* already ended */ }
    // Adaptation phrases are the Japanese glossary terms, so only apply them to
    // Japanese recognition (they would not help — and could hurt — other langs).
    // BOOST=0 は「ヒントを送らない」＝モデルへの後押しを完全に切る（かな→漢字の
    // 後処理・読み照合は用語集から作られるので、そのまま効き続ける）。
    // 後押しの強さは言語ごとに持つ（日本語は乗っ取りのため0・外国語は実測で決める）
    const boost = glossaryField ? BOOST_FOREIGN : BOOST;
    const useAdaptation = phrases.length > 0 && boost > 0;
    const config = {
      explicitDecodingConfig: { encoding: "LINEAR16" as const, sampleRateHertz: 16000, audioChannelCount: 1 },
      languageCodes: [sttLanguageCode(lang)],
      model: SPEECH_MODEL,
      ...(useAdaptation
        ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: phrases.map((value) => ({ value, boost })) } }] } }
        : {}),
    };
    // V2 streaming needs the recognizer in the routing header (x-goog-request-params);
    // without it the regional backend rejects the request ("Invalid resource field value").
    const s = client._streamingRecognize({
      otherArgs: { headers: { "x-goog-request-params": `recognizer=${encodeURIComponent(RECOGNIZER)}` } },
    });
    s.on("data", async (data: StreamingResult) => {
      consecutiveErrors = 0; // 正常に認識が流れている
      const r = data.results?.[0];
      if (!r) return;
      const raw = r.alternatives?.[0]?.transcript ?? "";
      if (!raw) return;
      const base = applyCorrections(raw);
      if (r.isFinal) {
        // 無音ゲート：発話音量が観測されていない区間の確定結果は、モデルの幻聴
        // （無音・微小雑音からの創作。数の読み上げ・あいづち・挨拶など）とみなし破棄する。
        const verdict = gate.onFinal();
        // 分割確定（同じ音声から続けて出た2つ目）は、直前の判定を引き継いでいる印。
        const cont = verdict.continuation ? " 分割確定(前の判定を引き継ぎ)" : "";
        if (!verdict.accept) {
          console.log(`[stt-gate] 無音区間のため破棄 speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)}${cont} raw=${JSON.stringify(raw)}`);
          recordGuard("stt-guard-gate", `無音区間の認識結果を破棄（幻聴とみなした）: "${raw.slice(0, 60)}" speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)}${cont}`);
          onInterim?.("");  // 表示済みの途中経過を消す（確定は破棄したため）
          return;
        }
        // 用語集オウム返しガード：ヒント一覧をそのまま読み上げた形の暴走出力は破棄する。
        const dump = inspectGlossaryDump(base, phrases);
        if (dump.isDump) {
          console.log(`[stt-dump] 用語集の羅列とみなし破棄 hits=${dump.hits} other=${dump.otherRatio.toFixed(2)} raw=${JSON.stringify(raw)}`);
          recordGuard("stt-guard-dump", `用語集の羅列とみなし破棄: "${raw.slice(0, 60)}" hits=${dump.hits}`);
          onInterim?.("");  // 表示済みの途中経過を消す（確定は破棄したため）
          return;
        }
        // 暴走出力ガード：数字の連番のような同種文字の羅列は幻聴（自信度も高く出るため先に判定）。
        if (isDegenerateRun(base)) {
          console.log(`[stt-run] 連番・繰り返しの暴走とみなし破棄 raw=${JSON.stringify(raw.slice(0, 60))}${raw.length > 60 ? "…" : ""}`);
          recordGuard("stt-guard-run", `連番・繰り返しの暴走とみなし破棄: "${raw.slice(0, 60)}"`);
          onInterim?.("");  // 表示済みの途中経過を消す（確定は破棄したため）
          return;
        }
        // 自信度ガード：ささやき・息・衣擦れ等の「続く音」は無音ゲートを通るため、
        // その先はモデルの自信度で見分ける（実発話は極小音量でも0.91以上・幻聴は0.67〜）。
        // 自信度が無い/0のときは破棄しない（モデルや言語により返さない場合の安全側）。
        const confidence = r.alternatives?.[0]?.confidence ?? null;
        // 音量と長さが「明らかに人の声」なら、自信度が低くても本物として通す。
        //
        // ★分割確定の引き継ぎ（continuation）は、引き継いだ音量が**前の発話のもの**なので、
        // 文の長さ（CONT_CLEAR_MIN_CHARS）で本物の言い残しか幻聴の相づちかを見分ける。
        // 無条件に緩めると幻聴の相づちが素通りし（2026-08-14 S8）、無条件に厳しくすると
        // 本物の後半が欠落した（2026-08-16 S5・0.773で破棄）。経緯は CONT_CLEAR_MIN_CHARS
        // の定義コメント参照。効果は [stt-diag]/[stt-conf] の conf= で検証する。
        const volumeOk = verdict.maxRms >= CLEAR_VOICE_RMS && verdict.speechChunks >= CLEAR_VOICE_CHUNKS;
        const clearVoice = clearVoiceEligible(verdict, coreLength(base));
        const minConfidence = clearVoice ? MIN_CONFIDENCE_CLEAR : MIN_CONFIDENCE;
        if (confidence != null && confidence > 0 && confidence < minConfidence) {
          const label = clearVoice ? "明らかな声" : !volumeOk ? "音量が微妙" : "分割の続きの短文";
          const why = `confidence=${confidence.toFixed(3)} 基準=${minConfidence}（${label} speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)}）`;
          console.log(`[stt-conf] 自信度が低いため破棄 ${why} raw=${JSON.stringify(raw)}`);
          recordGuard("stt-guard-conf", `自信度が低いため破棄（幻聴とみなした）: "${raw.slice(0, 60)}" ${why}`);
          onInterim?.("");  // 表示済みの途中経過を消す（確定は破棄したため）
          return;
        }
        // 確定時のみ、同音の別表記を用語集の登録どおりに矯正する。
        // 日本語は読み照合（kuromoji）、外国語は発音・表記の照合（施策2）。
        const transcript = glossaryField
          ? await applyForeignCorrection(base, glossaryField, foreignMap)
          : await applyReadingMatch(base, readingMap);
        // ── 診断ログ（用語集語の誤挿入調査＋各ガードのしきい値調整）─────────
        // 生の認識結果(raw)→かな漢字補正(corrected)→読み照合(final)を段階で記録。
        // 話していない登録語が混入した場合、それが raw の時点で入っているか（＝モデル側か
        // 後処理側か）を切り分けるためのログ。confidence は自信度ガードの調整用に常時記録。
        console.log(`[stt-diag] speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)} conf=${confidence == null ? "-" : confidence.toFixed(3)} 基準=${minConfidence}${cont} raw=${JSON.stringify(raw)} corrected=${JSON.stringify(base)} final=${JSON.stringify(transcript)}`);
        socket.emit("stt:final", { transcript });
        flushCollector?.(transcript); // 通話終了時の拾い上げ中なら、サーバー側でも回収する
        noteSttFinal(socket.id); // 性能測定：発話終了→確定テキスト
      } else {
        // interim（入力中プレビュー）も同じ基準で抑止し、幻聴の「打ちかけ表示」を防ぐ
        if (!gate.hasSpeech()) return;
        if (inspectGlossaryDump(base, phrases).isDump) return;
        if (isDegenerateRun(base)) return;
        socket.emit("stt:interim", { transcript: base });
        onInterim?.(base); // ゲートを通った途中経過＝「実際に話している」確かな合図
      }
    });
    s.on("error", (err: Error) => {
      console.error("[stt] stream error:", err.message);
      if (stream === s) stream = null;
      if (!running) return; // 停止後のエラー（半クローズ等）は無視
      // 稼働中の一時エラー（無音タイムアウト等）は自動で開き直してマイクを継続させる。
      // 連続で失敗し続ける場合のみ利用者にエラーを見せる（無限ループ防止）。
      if (consecutiveErrors < 3) {
        consecutiveErrors++;
        void openStream();
      } else {
        socket.emit("stt:error", { message: err.message });
        recordSocketError(socket.id, { type: "stt-stream", detail: `音声認識の接続エラーが連続し停止: ${err.message.slice(0, 120)}` });
      }
    });
    // First message: recognizer + streaming config. Subsequent writes are audio.
    const streamingFeatures: Record<string, unknown> = { interimResults: true };
    if (SPEECH_END_TIMEOUT_MS > 0) {
      // 発話の切れ目を自前で決める。enableVoiceActivityEvents を立てないと
      // voiceActivityTimeout は効かない（Google STT V2 の仕様）。
      streamingFeatures.enableVoiceActivityEvents = true;
      streamingFeatures.voiceActivityTimeout = {
        speechEndTimeout: {
          seconds: Math.floor(SPEECH_END_TIMEOUT_MS / 1000),
          nanos: (SPEECH_END_TIMEOUT_MS % 1000) * 1_000_000,
        },
      };
    }
    s.write({ recognizer: RECOGNIZER, streamingConfig: { config, streamingFeatures } });
    stream = s;
    // 開くまでに届いていた音声を、届いた順に流し込む（話し出しの欠けを防ぐ）。
    if (pendingAudio.length) {
      const waiting = pendingAudio;
      pendingAudio = [];
      for (const buf of waiting) {
        try { s.write({ audio: buf }); } catch { /* stream closing */ }
      }
      console.log(`[stt] 開通までに届いた音声 ${waiting.length} チャンク(${(waiting.length / 10).toFixed(1)}秒)を送出`);
    }
  }

  function scheduleRestart(): void {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(async () => {
      if (!running) return;
      const old = stream; // open the new stream first, then end the old → no gap
      await openStream();
      try { old?.end(); } catch { /* already ended */ }
      scheduleRestart();
    }, STREAM_RESTART_MS);
  }

  function stopStream(): void {
    running = false;
    onInterim?.(""); // 表示済みの途中経過を消す（マイクOFF後に確定が来ない場合の残留防止）
    pendingAudio = []; // 次にONにしたとき、前回の言い残しが混ざらないように捨てる
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const s = stream;
    stream = null;
    try { s?.end(); } catch { /* already ended */ }
  }

  /**
   * 通話終了時に「言い終わっているが、まだ確定していない」発話を確定させる
   * （2026-08-16 日本語S4: 「ありがとうございました」の直後に終了ボタンを押すと、
   * 確定は話し終わりの約1.5秒後に来るため、間に合わず最後の言葉が消えていた）。
   *
   * 仕組み: ストリームを破棄せず**半クローズ（end）**すると、Google は手元に残っている
   * 音声から確定を作って返してくる。その確定は通常どおりゲート（無音・羅列・暴走・
   * 自信度）を通り、通ったものだけを回収して返す。呼び出し元（call:end）が係員への
   * 表示と通話記録への追記を行う。
   *
   * 待つのは「最後の確定より後に声があった」ときだけ。声が無ければ即座に空で返るので、
   * 通常の終了が遅くなることはない。上限は FLUSH_MAX_MS（既定3秒。マイクOFF時の
   * クライアント側ドレイン3秒と同じ値）。
   */
  const FLUSH_MAX_MS = Number(process.env.STT_FLUSH_MAX_MS ?? "3000");
  async function flushPendingFinal(): Promise<string[]> {
    if (!running || !stream || !gate.hasSpeech()) return [];
    const collected: string[] = [];
    flushCollector = (t) => collected.push(t);
    // stopStream 相当の後片付け。ただしストリームは破棄せず半クローズして結果を待つ。
    running = false;
    pendingAudio = [];
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const s = stream;
    stream = null;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FLUSH_MAX_MS);
      const settle = () => {
        clearTimeout(timer);
        // "end" はデータ配送の後に来るが、確定の処理（読み照合の await）が
        // まだ走っていることがあるので、少しだけ待ってから締める。
        setTimeout(resolve, 200);
      };
      s.on("end", settle);
      s.on("error", settle);
      try { s.end(); } catch { settle(); }
    });
    flushCollector = null;
    return collected;
  }
  // 通話終了処理（socketServer の call:end）から呼べるように、ソケットに載せておく
  socket.data.sttFlush = flushPendingFinal;

  socket.on("stt:start", async (payload?: { lang?: string }) => {
    lang = payload?.lang || "ja-JP";
    // ★「受け入れ開始」の印は、待ち時間の入る処理より**先**に立てる。
    //   用語集の取得を待ってからにすると、その間に届いた音声が捨てられてしまう。
    running = true;
    consecutiveErrors = 0;
    gate.reset();      // マイクON時に音量計測をやり直す
    micStartedAt = Date.now();
    voiceRun = 0;
    pendingAudio = [];
    const terms = await getGlossaryTermsFresh().catch(() => [] as GlossaryTerm[]);
    glossaryField = glossaryFieldOf(lang);
    // 認識へのヒント（施策3）は**その言語の表記**を渡す。日本語の通話には日本語欄、
    // 中国語の通話には中国語欄。従来は言語に関わらず日本語欄を渡していた。
    phrases = (glossaryField
      ? terms.map((t) => (t[glossaryField!] as string | undefined) ?? "")
      : terms.map((t) => t.ja)
    ).filter(Boolean);
    corrections = buildCorrections(terms);
    caseRules = buildCaseRules(terms);
    readingMap = buildReadingMap(terms);
    // 外国語は発音・表記での照合表を用意する（施策2）
    foreignMap = glossaryField ? await buildForeignMap(terms, glossaryField).catch(() => []) : [];
    if (glossaryField) warmUpPinyin();
    else warmUpTokenizer(); // 辞書ロードを先行させ、初回の確定までに準備を整える
    await openStream();
    scheduleRestart();
  });

  socket.on("stt:audio", (chunk: ArrayBuffer | Buffer) => {
    // running=false（マイクOFF中）の音声だけは捨てる。ストリームがまだ開いていない
    // 場合は捨てずに貯めて、開いた直後に送る（話し出しの欠け対策）。
    if (!running) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // 音声の転送を最優先（音量測定に万一問題があっても認識用の音声は絶対に欠けさせない）
    if (stream) {
      try {
        stream.write({ audio: buf });
      } catch { /* stream closing */ }
    } else if (pendingAudio.length < PENDING_MAX) {
      pendingAudio.push(buf);
    }
    const rms = chunkRms(buf);
    gate.onChunk(rms); // 無音ゲート：チャンクごとの音量を記録
    // 「お客様発話中」：発話とみなせる音量が続いている間、係員画面へ知らせる。
    // 消すのは確定テキストが出たとき（socketServer側で判断）なので、ここでは点灯のみ通知する。
    if (rms >= SPEECH_RMS) {
      voiceRun++;
      // マイクON直後の猶予中は「発話中」の通知だけ止める（認識・性能測定はそのまま）
      if (voiceRun >= MIN_SPEECH_CHUNKS && Date.now() - micStartedAt >= VOICE_BADGE_WARMUP_MS) {
        onVoiceActivity?.();
      }
      // 性能測定：声が聞こえた最後の時刻＝発話終了の基準（無音では更新しない）
      noteSttSpeech(socket.id);
    } else {
      voiceRun = 0;
    }
    // 係員が「お客様の声」をONにしていれば、同じ音を担当係員の画面へも配る。
    // ★認識に関わる処理を全部終えた最後に呼ぶ。ここで万一つまずいても、
    //   音声認識・無音ゲート・発話中表示には影響が出ない位置にしてある。
    if (onAudio) {
      try { onAudio(buf); } catch { /* 中継の失敗で認識を巻き添えにしない */ }
    }
  });

  socket.on("stt:stop", stopStream);
  socket.on("disconnect", stopStream);
}
