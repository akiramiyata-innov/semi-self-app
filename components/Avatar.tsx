"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSharedAudioContext } from "@/lib/audioUnlock";

interface AvatarProps {
  /** Google TTS audio (base64 MP3) for the staff's speech. */
  audioBase64?: string;
  onSpeakingChange?: (speaking: boolean) => void;
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
  audioBase64,
  onSpeakingChange,
  visible = true,
  size = "lg",
}: AvatarProps) {
  const [speaking, setSpeaking] = useState(false);
  const [entered, setEntered] = useState(false);
  const [mouth, setMouth] = useState<MouthShape>("closed");
  // The currently-playing Google TTS node, kept so we can stop it if the call
  // ends mid-sentence (otherwise the voice plays on after the screen closes).
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const onSpeakingRef = useRef(onSpeakingChange);
  // Drives the mouth while speaking. A timer, not requestAnimationFrame: rAF is
  // suspended whenever the page isn't painting, which freezes the mouth mid-word.
  const mouthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const height = SIZE_MAP[size];

  useEffect(() => { onSpeakingRef.current = onSpeakingChange; }, [onSpeakingChange]);

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

  /** Play the next queued segment; called again by each source's `ended`. */
  const playNext = useCallback((ctx: AudioContext) => {
    const buffer = queueRef.current.shift();
    if (!buffer) {
      // Queue drained — now (and only now) the avatar stops "speaking".
      sourceRef.current = null;
      setSpeaking(false);
      onSpeakingRef.current?.(false);
      stopMouth();
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
    setSpeaking(true);
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
  }, [stopMouth]);

  // --- Play via Web Audio API (Google TTS base64) ---
  // Google TTS is the only voice — there is deliberately no Web Speech fallback,
  // which used a device voice (sometimes male) and broke the consistent female
  // station-attendant voice. If the audio can't play, the avatar stays silent
  // (the staff's words are still shown as on-screen text).
  useEffect(() => {
    if (!audioBase64) return;

    // Reuse the shared context that was unlocked on the user's tap (see
    // lib/audioUnlock). Creating a fresh context here instead would start it
    // suspended — browsers only let audio play from a gesture-unlocked context.
    const ctx = getSharedAudioContext();
    if (!ctx) return;

    decodeChainRef.current = decodeChainRef.current
      .then(async () => {
        if (ctx.state === "suspended") await ctx.resume();

        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
        queueRef.current.push(buffer);
        // Idle → start playing; otherwise the current source's `ended` chain
        // picks this segment up in order.
        if (!sourceRef.current) playNext(ctx);
      })
      .catch((e) => {
        console.error("[avatar] audio decode/playback failed:", e);
      });
  }, [audioBase64, playNext]);

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
      <div className="text-center shrink-0">
        {speaking ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-blue-600 font-medium">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500" />
            </span>
            お話し中...
          </span>
        ) : (
          <span className="text-sm text-gray-400">お気軽にどうぞ</span>
        )}
      </div>
    </div>
  );
}
