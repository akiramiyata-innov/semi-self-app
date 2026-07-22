import type { Socket } from "socket.io";
import type { v2 } from "@google-cloud/speech";
import { getSpeechClient, RECOGNIZER, SPEECH_MODEL } from "../lib/speechClient";
import { getGlossaryTermsFresh } from "../lib/glossaryClient";
import type { GlossaryTerm } from "../lib/types";
import { buildReadingMap, applyReadingMatch, warmUpTokenizer, type ReadingEntry } from "../lib/reading";
import { noteSttAudio, noteSttFinal } from "./metrics";

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

// 地名によくある接尾辞漢字とその読み。chirp_2 は「語幹（かな）＋接尾辞（漢字）」の
// 混在で出すことがある（例: 狸穴町→「まみあな町」）ので、その形も置換対象に含める。
const SUFFIX_KANJI: Array<{ kanji: string; readings: string[] }> = [
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
 * Registers per-socket streaming STT (Speech-to-Text **V2**, chirp_2 model). The
 * client sends `stt:start` then raw 16kHz mono PCM chunks via `stt:audio`, and
 * receives `stt:interim` / `stt:final` transcripts in real time. `stt:stop` (or
 * disconnect) ends it. Registered glossary terms are passed as inline model
 * adaptation so domain words (station names, jargon) are recognized correctly —
 * this is what the classic V1 phrase hints failed to do.
 */
export function registerSttHandlers(socket: Socket): void {
  let stream: SpeechStream | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let lang = "ja-JP";
  let phrases: string[] = [];
  let corrections: Correction[] = [];
  let readingMap: ReadingEntry[] = [];
  let running = false;
  let consecutiveErrors = 0;

  /** 認識結果のカナ読みを、登録された漢字に置き換える（chirp_2 が漢字化しきれない語の後処理）。 */
  function applyCorrections(text: string): string {
    let out = text;
    for (const c of corrections) {
      if (out.includes(c.from)) out = out.split(c.from).join(c.to);
    }
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
        // 確定時のみ、読み照合（kuromoji）で同音の別漢字も矯正する。
        const transcript = await applyReadingMatch(base, readingMap);
        socket.emit("stt:final", { transcript });
        noteSttFinal(socket.id); // 性能測定：発話終了→確定テキスト
      } else {
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
    readingMap = buildReadingMap(terms);
    warmUpTokenizer(); // 辞書ロードを先行させ、初回の確定までに準備を整える
    running = true;
    consecutiveErrors = 0;
    await openStream();
    scheduleRestart();
  });

  socket.on("stt:audio", (chunk: ArrayBuffer | Buffer) => {
    if (!stream) return;
    noteSttAudio(socket.id); // 性能測定：最後に音声が届いた時刻＝発話終了の目安
    try {
      stream.write({ audio: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk) });
    } catch { /* stream closing */ }
  });

  socket.on("stt:stop", stopStream);
  socket.on("disconnect", stopStream);
}
