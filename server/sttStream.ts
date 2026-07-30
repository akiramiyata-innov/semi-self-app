import type { Socket } from "socket.io";
import type { v2 } from "@google-cloud/speech";
import { getSpeechClient, RECOGNIZER, SPEECH_MODEL } from "../lib/speechClient";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import type { GlossaryTerm } from "../lib/types";
import { buildReadingMap, applyReadingMatch, warmUpTokenizer, SUFFIX_KANJI, type ReadingEntry } from "../lib/reading";
import { noteSttSpeech, noteSttFinal } from "./metrics";
import { SilenceGate, chunkRms, SPEECH_RMS, MIN_SPEECH_CHUNKS } from "./silenceGate";
import { inspectGlossaryDump } from "./glossaryDump";

// Google streaming recognition has a per-stream time limit. Reopen the stream
// before then so long (2 min+) speech continues seamlessly.
const STREAM_RESTART_MS = 4.5 * 60 * 1000;
// V2 model adaptation caps the phrase boost at 20 (higher → INVALID_ARGUMENT).
const BOOST = 20;

type SpeechStream = ReturnType<v2.SpeechClient["_streamingRecognize"]>;

/** Minimal shape of a V2 StreamingRecognizeResponse we consume. */
interface StreamingResult {
  results?: Array<{
    isFinal?: boolean | null;
    alternatives?: Array<{ transcript?: string | null }> | null;
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
 * Registers per-socket streaming STT (Speech-to-Text **V2**, chirp_2 model). The
 * client sends `stt:start` then raw 16kHz mono PCM chunks via `stt:audio`, and
 * receives `stt:interim` / `stt:final` transcripts in real time. `stt:stop` (or
 * disconnect) ends it. Registered glossary terms are passed as inline model
 * adaptation so domain words (station names, jargon) are recognized correctly —
 * this is what the classic V1 phrase hints failed to do.
 */
export function registerSttHandlers(socket: Socket, onVoiceActivity?: () => void): void {
  let stream: SpeechStream | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let lang = "ja-JP";
  let phrases: string[] = [];
  let corrections: Correction[] = [];
  let caseRules: CaseRule[] = [];
  let readingMap: ReadingEntry[] = [];
  let running = false;
  let consecutiveErrors = 0;
  // 無音ゲート：発話音量が観測されていない区間の認識結果（モデルの幻聴）を破棄する
  const gate = new SilenceGate();
  // 「お客様発話中」表示用：発話音量が連続したチャンク数（0.2秒＝2チャンク続いたら通知）
  let voiceRun = 0;

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
    const useAdaptation = phrases.length > 0 && lang.startsWith("ja");
    const config = {
      explicitDecodingConfig: { encoding: "LINEAR16" as const, sampleRateHertz: 16000, audioChannelCount: 1 },
      languageCodes: [lang || "ja-JP"],
      model: SPEECH_MODEL,
      ...(useAdaptation
        ? { adaptation: { phraseSets: [{ inlinePhraseSet: { phrases: phrases.map((value) => ({ value, boost: BOOST })) } }] } }
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
        if (!verdict.accept) {
          console.log(`[stt-gate] 無音区間のため破棄 speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)} raw=${JSON.stringify(raw)}`);
          return;
        }
        // 用語集オウム返しガード：ヒント一覧をそのまま読み上げた形の暴走出力は破棄する。
        const dump = inspectGlossaryDump(base, phrases);
        if (dump.isDump) {
          console.log(`[stt-dump] 用語集の羅列とみなし破棄 hits=${dump.hits} other=${dump.otherRatio.toFixed(2)} raw=${JSON.stringify(raw)}`);
          return;
        }
        // 確定時のみ、読み照合（kuromoji）で同音の別漢字も矯正する。
        const transcript = await applyReadingMatch(base, readingMap);
        // ── 診断ログ（用語集語の誤挿入調査＋無音ゲートしきい値調整）─────────
        // 生の認識結果(raw)→かな漢字補正(corrected)→読み照合(final)を段階で記録。
        // 話していない登録語が混入した場合、それが raw の時点で入っているか（＝モデル側か
        // 後処理側か）を切り分けるためのログ。動作は変えず記録するだけ（調査後に削除可）。
        console.log(`[stt-diag] speech=${verdict.speechChunks} maxRms=${Math.round(verdict.maxRms)} raw=${JSON.stringify(raw)} corrected=${JSON.stringify(base)} final=${JSON.stringify(transcript)}`);
        socket.emit("stt:final", { transcript });
        noteSttFinal(socket.id); // 性能測定：発話終了→確定テキスト
      } else {
        // interim（入力中プレビュー）も同じ基準で抑止し、幻聴の「打ちかけ表示」を防ぐ
        if (!gate.hasSpeech()) return;
        if (inspectGlossaryDump(base, phrases).isDump) return;
        socket.emit("stt:interim", { transcript: base });
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
      }
    });
    // First message: recognizer + streaming config. Subsequent writes are audio.
    s.write({ recognizer: RECOGNIZER, streamingConfig: { config, streamingFeatures: { interimResults: true } } });
    stream = s;
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
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    const s = stream;
    stream = null;
    try { s?.end(); } catch { /* already ended */ }
  }

  socket.on("stt:start", async (payload?: { lang?: string }) => {
    lang = payload?.lang || "ja-JP";
    const terms = await getGlossaryTermsFresh().catch(() => [] as GlossaryTerm[]);
    phrases = terms.map((t) => t.ja).filter(Boolean);
    corrections = buildCorrections(terms);
    caseRules = buildCaseRules(terms);
    readingMap = buildReadingMap(terms);
    warmUpTokenizer(); // 辞書ロードを先行させ、初回の確定までに準備を整える
    running = true;
    consecutiveErrors = 0;
    gate.reset(); // マイクON時に音量計測をやり直す
    await openStream();
    scheduleRestart();
  });

  socket.on("stt:audio", (chunk: ArrayBuffer | Buffer) => {
    if (!stream) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // 音声の転送を最優先（音量測定に万一問題があっても認識用の音声は絶対に欠けさせない）
    try {
      stream.write({ audio: buf });
    } catch { /* stream closing */ }
    const rms = chunkRms(buf);
    gate.onChunk(rms); // 無音ゲート：チャンクごとの音量を記録
    // 「お客様発話中」：発話とみなせる音量が続いている間、係員画面へ知らせる。
    // 消すのは確定テキストが出たとき（socketServer側で判断）なので、ここでは点灯のみ通知する。
    if (rms >= SPEECH_RMS) {
      voiceRun++;
      if (voiceRun >= MIN_SPEECH_CHUNKS) onVoiceActivity?.();
      // 性能測定：声が聞こえた最後の時刻＝発話終了の基準（無音では更新しない）
      noteSttSpeech(socket.id);
    } else {
      voiceRun = 0;
    }
  });

  socket.on("stt:stop", stopStream);
  socket.on("disconnect", stopStream);
}
