"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSharedAudioContext } from "@/lib/audioUnlock";

interface AvatarProps {
  /**
   * これから鳴らす音声（base64 MP3）の受け渡し箱。
   *
   * ★state ではなく ref で渡す（v1.43.0）。文ごとの先行再生では、1つの返答が
   * **複数回に分けて**届く。state だと同じ瞬間に届いた2つがまとめられて
   * 前のほうが消えたり、たまたま中身が同じ2文が「変化なし」とみなされて
   * 鳴らされなかったりする。ref に積めばどちらも起きない。
   */
  audioQueueRef?: React.RefObject<string[]>;
  /** 上の箱に何か積まれたことを知らせる合図（増えるたびに取り出す）。 */
  audioTick?: number;
  /**
   * この返答の音声がまだ続くか（v1.43.0）。
   *
   * 文ごとに分けて届くようになったため、1つ鳴らし終えて箱が空でも
   * **まだ続きが来る途中かもしれない**。true の間は読み上げ終了を伝えない。
   * これが無いと、続きが間に合わなかったときにお客様のマイクが返答の途中で戻り、
   * 待たせていた通話終了も先に進んでしまう。
   */
  moreAudioComing?: boolean;
  onSpeakingChange?: (speaking: boolean) => void;
  /**
   * 音声を再生できなかったときに呼ばれる（デコード失敗・自動再生のブロック等）。
   * サーバーは音声を送れているのでここでしか検知できず、放置するとお客様には音も
   * 文字も届かない。親が文字の表示と係員への通知を行う。
   */
  onPlaybackError?: () => void;
  visible?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
}

/** Height in px. Width follows from the artwork's aspect ratio. */
const SIZE_MAP = { sm: 220, md: 380, lg: 560, xl: 860 };

// base.svg's viewBox. The mouth artwork uses the same units, so mouth placement
// is expressed as a percentage of these dimensions.
const BASE_W = 805.1;
const BASE_H = 1448;

/** Mouth anchor on the face, in base.svg units (centre-x, top edge of the lips). */
const MOUTH_CENTER_X = 406;
const MOUTH_TOP_Y = 600;

type MouthShape = "closed" | "a" | "i" | "u" | "e" | "o";

/** Each mouth SVG's own viewBox width, in the same units as base.svg. */
const MOUTH_WIDTH: Record<MouthShape, number> = {
  closed: 86.2,
  a: 77,
  i: 94.3,
  u: 36.9,
  e: 79.9,
  o: 41,
};

const MOUTH_SHAPES = Object.keys(MOUTH_WIDTH) as MouthShape[];

// How often the mouth shape is re-evaluated while speaking. ~110ms ≈ a natural
// syllable pace; faster (e.g. 60ms) looks twitchy, much slower lags the audio.
const MOUTH_TICK_MS = 110;
// Exponential smoothing of the loudness so borderline values don't flip the
// mouth back and forth between ticks. Light enough that loud syllables still
// reach the wide-open "a" shape. Lower = smoother/slower to react.
const MOUTH_SMOOTHING = 0.6;

/**
 * Loudness → how far the mouth opens. Thresholds are RMS of the playing audio
 * (0–1), tuned against Google TTS output: its speech sits around 0.10 RMS with
 * peaks near 0.19, so these bands keep the mouth moving instead of parked on "a".
 * Language-agnostic, so it works for all eight supported languages.
 * The `i` and `e` shapes stay unused here — they need phoneme data, not volume.
 */
function mouthForLevel(rms: number): MouthShape {
  if (rms < 0.02) return "closed";
  if (rms < 0.06) return "u";
  if (rms < 0.12) return "o";
  return "a";
}

export function Avatar({
  audioQueueRef,
  audioTick,
  moreAudioComing = false,
  onSpeakingChange,
  onPlaybackError,
  visible = true,
  size = "lg",
}: AvatarProps) {
  const [entered, setEntered] = useState(false);
  const [mouth, setMouth] = useState<MouthShape>("closed");
  // The currently-playing Google TTS node, kept so we can stop it if the call
  // ends mid-sentence (otherwise the voice plays on after the screen closes).
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const onSpeakingRef = useRef(onSpeakingChange);
  const onPlaybackErrorRef = useRef(onPlaybackError);
  // Drives the mouth while speaking. A timer, not requestAnimationFrame: rAF is
  // suspended whenever the page isn't painting, which freezes the mouth mid-word.
  const mouthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const height = SIZE_MAP[size];

  useEffect(() => { onSpeakingRef.current = onSpeakingChange; }, [onSpeakingChange]);
  useEffect(() => { onPlaybackErrorRef.current = onPlaybackError; }, [onPlaybackError]);

  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setEntered(true), 50);
      return () => clearTimeout(t);
    } else {
      setEntered(false);
    }
  }, [visible]);

  const stopMouth = useCallback(() => {
    if (mouthTimerRef.current) { clearInterval(mouthTimerRef.current); mouthTimerRef.current = null; }
    setMouth("closed");
  }, []);

  useEffect(() => stopMouth, [stopMouth]);

  // Decoded TTS segments waiting to play, strictly in arrival order. Long staff
  // speech arrives as MULTIPLE audio segments (one per STT final, ~every 30-60s
  // of continuous talk); playing each the moment it arrived overlapped the
  // voices, and the old source's `ended` event killed the mouth timer of the
  // newer one — lip sync died mid-audio (bug found in v1.14.0 with ~3min input).
  const queueRef = useRef<AudioBuffer[]>([]);
  // Serializes decodeAudioData calls so segments enqueue in arrival order even
  // when a later (smaller) segment would decode faster than an earlier one.
  const decodeChainRef = useRef<Promise<void>>(Promise.resolve());

  // Silence the audio when the avatar unmounts — e.g. the user presses キャンセル
  // mid-sentence. Without this the Web Audio source keeps playing to the end even
  // though the call screen has already closed. (The shared AudioContext is left
  // open on purpose so it stays unlocked for the next call.)
  useEffect(() => {
    return () => {
      queueRef.current = []; // drop queued segments so onended can't chain on
      const src = sourceRef.current;
      if (src) {
        src.onended = null; // avoid playNext firing on the unmounted component
        try { src.stop(); } catch { /* already stopped */ }
        sourceRef.current = null;
      }
    };
  }, []);

  /** いま鳴らしている最中か（続きを待っている間も true のまま扱う判定に使う）。 */
  const speakingRef = useRef(false);
  /** サーバーから「まだ続きが来る」と言われているか。 */
  const moreComingRef = useRef(moreAudioComing);
  /**
   * 受け取ったが、まだ鳴らせる形に変換できていない音声の数。
   *
   * ★`tts:done`（サーバーが送り終えた合図）だけでは足りない。届いていても変換の
   * 途中なら、前の音声を鳴らし終えた時点でいったん空になり、読み上げ終了と
   * 誤判定する（検証で実際に発生: 1つ目を鳴らし終えた0.5秒後に「終了」を通知し、
   * 3.5秒後に2つ目が鳴り始めた）。変換待ちの数も見て、両方ゼロで初めて終了とする。
   */
  const pendingDecodesRef = useRef(0);
  /** まだ続きがある＝読み上げ終了を伝えてはいけない状態か。 */
  const stillExpectingAudio = useCallback(
    () => moreComingRef.current || pendingDecodesRef.current > 0,
    [],
  );

  /** 読み上げが終わったことを親へ伝える（口も閉じる）。二重に伝えない。 */
  const finishSpeaking = useCallback(() => {
    if (!speakingRef.current) return;
    speakingRef.current = false;
    onSpeakingRef.current?.(false);
    stopMouth();
  }, [stopMouth]);

  /** Play the next queued segment; called again by each source's `ended`. */
  const playNext = useCallback((ctx: AudioContext) => {
    const buffer = queueRef.current.shift();
    if (!buffer) {
      sourceRef.current = null;
      // ★続きが来る途中なら、まだ読み上げ終了にしない（口だけ閉じて待つ）。
      //   次の音声が届いたら、下の取り出し処理がここから再開する。
      if (stillExpectingAudio()) { stopMouth(); return; }
      // Queue drained — now (and only now) the avatar stops "speaking".
      finishSpeaking();
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const samples = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    analyser.connect(ctx.destination);

    source.onended = () => playNext(ctx);
    sourceRef.current = source;
    speakingRef.current = true;
    onSpeakingRef.current?.(true);
    source.start();

    // Fresh mouth timer bound to THIS source's analyser.
    stopMouth();
    let smoothedRms = 0;
    mouthTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      smoothedRms += (rms - smoothedRms) * MOUTH_SMOOTHING;
      const next = mouthForLevel(smoothedRms);
      setMouth((prev) => (prev === next ? prev : next));
    }, MOUTH_TICK_MS);
  }, [stopMouth, finishSpeaking, stillExpectingAudio]);

  // 「もう続きは来ない」と分かった時点で、既に鳴り終わっていれば読み上げ終了を伝える。
  // 最後の音声を鳴らし終えたあとに合図が届いた場合を拾うための後始末。
  useEffect(() => {
    moreComingRef.current = moreAudioComing;
    if (!stillExpectingAudio() && !sourceRef.current && queueRef.current.length === 0) finishSpeaking();
  }, [moreAudioComing, finishSpeaking, stillExpectingAudio]);

  // --- Play via Web Audio API (Google TTS base64) ---
  // Google TTS is the only voice — there is deliberately no Web Speech fallback,
  // which used a device voice (sometimes male) and broke the consistent female
  // station-attendant voice. If the audio can't play, the avatar stays silent
  // (the staff's words are still shown as on-screen text).
  useEffect(() => {
    const box = audioQueueRef?.current;
    if (!box || box.length === 0) return;
    // 積まれている分をまとめて取り出す。取り出しは同期なので取りこぼさない。
    const arrived = box.splice(0, box.length);

    // Reuse the shared context that was unlocked on the user's tap (see
    // lib/audioUnlock). Creating a fresh context here instead would start it
    // suspended — browsers only let audio play from a gesture-unlocked context.
    const ctx = getSharedAudioContext();
    if (!ctx) {
      // Web Audio が使えないブラウザ。黙って諦めると音も文字も出ないので失敗として扱う。
      onPlaybackErrorRef.current?.();
      return;
    }

    pendingDecodesRef.current += arrived.length;
    for (const audioBase64 of arrived) {
      decodeChainRef.current = decodeChainRef.current
        .then(async () => {
          try {
            // ブラウザは「画面を触るまで音を鳴らさない」ので、止まっていたら動かし直す。
            if (ctx.state === "suspended") {
              try { await ctx.resume(); } catch { /* 次の判定で失敗として扱う */ }
            }
            // ★resume() が例外を投げずに、止まったままのことがある（許可が下りていない・
            //   端末側の音声デバイスの問題など）。ここで弾かないと、音が出ないのに
            //   source.start() まで進み、ended が来ないため **アバターが読み上げ中のまま
            //   固まり、お客様のマイクが自動で戻らない**。しかも誰にも通知が出ない。
            //   実機で「お客様側のPCだけ音が鳴らない」事象があり、この経路を塞いだ。
            if (ctx.state !== "running") {
              throw new Error(`audio context is ${ctx.state}`);
            }

            const binary = atob(audioBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

            const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
            queueRef.current.push(buffer);
          } finally {
            // 成否にかかわらず1つ分の「変換待ち」を解消する（数がずれると
            // 読み上げ終了が伝わらないまま固まる）。
            pendingDecodesRef.current--;
          }
          // Idle → start playing; otherwise the current source's `ended` chain
          // picks this segment up in order.
          if (!sourceRef.current) playNext(ctx);
        })
        .catch((e) => {
          console.error("[avatar] audio decode/playback failed:", e);
          // 音も文字も届かない状態を防ぐため、親に知らせる（文字表示＋係員への通知）。
          onPlaybackErrorRef.current?.();
          // 変換に失敗したまま「続きを待っている」状態にしない
          if (!stillExpectingAudio() && !sourceRef.current && queueRef.current.length === 0) finishSpeaking();
        });
    }
  }, [audioTick, audioQueueRef, playNext, stillExpectingAudio, finishSpeaking]);

  if (!visible) return null;

  const containerClass = [
    "avatar-container",
    entered ? "avatar-entrance" : "opacity-0",
  ].join(" ");

  return (
    <div className="flex flex-col items-center justify-end gap-3 h-full min-h-0">
      <div
        className={`${containerClass} relative min-h-0 flex-1 w-auto`}
        style={{ maxHeight: height, aspectRatio: `${BASE_W} / ${BASE_H}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/avatar/base.svg"
          alt="駅員アバター"
          className="w-full h-full select-none"
          draggable={false}
        />
        {/* All mouth shapes are stacked and cross-fade via opacity, so shape
            changes ease in/out instead of snapping between images. */}
        {MOUTH_SHAPES.map((shape) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={shape}
            src={`/avatar/mouth-${shape}.svg`}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="absolute select-none"
            style={{
              left: `${(MOUTH_CENTER_X / BASE_W) * 100}%`,
              top: `${(MOUTH_TOP_Y / BASE_H) * 100}%`,
              width: `${(MOUTH_WIDTH[shape] / BASE_W) * 100}%`,
              transform: "translateX(-50%)",
              opacity: shape === mouth ? 1 : 0,
              transition: "opacity 120ms ease-in-out",
            }}
          />
        ))}
      </div>
      {/* アバターの下には何も表示しない（「お気軽にどうぞ」「お話し中...」は
          外国語のお客様には読めないため削除した）。発話中かどうかは
          onSpeakingChange で親へ伝えており、画面表示には使っていない。 */}
    </div>
  );
}
