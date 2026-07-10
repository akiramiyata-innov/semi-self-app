"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LangCode } from "@/lib/socketEvents";
import { getLang } from "@/lib/languages";

interface AvatarProps {
  audioBase64?: string;
  /** Fallback: text to speak via Web Speech Synthesis when audioBase64 is absent */
  fallbackText?: string;
  fallbackLang?: LangCode;
  /**
   * Increment this counter each time a new staff speech arrives (even same text).
   * The fallback useEffect depends on this key so it always fires, avoiding
   * the React "same state value = no re-render" problem.
   */
  fallbackKey?: number;
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

/** Each mouth SVG's own viewBox width, in the same units as base.svg. */
const MOUTH_WIDTH: Record<MouthShape, number> = {
  closed: 86.2,
  a: 77,
  i: 94.3,
  u: 36.9,
  e: 79.9,
  o: 41,
};

type MouthShape = "closed" | "a" | "i" | "u" | "e" | "o";

/** How often the mouth is re-evaluated while speaking. */
const MOUTH_TICK_MS = 60;

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

/** Shapes cycled when we can't measure the audio (Web Speech Synthesis fallback). */
const FALLBACK_CYCLE: MouthShape[] = ["a", "o", "u", "a", "closed", "o", "a", "u"];

export function Avatar({
  audioBase64,
  fallbackText,
  fallbackLang = "ja",
  fallbackKey,
  onSpeakingChange,
  visible = true,
  size = "lg",
}: AvatarProps) {
  const [speaking, setSpeaking] = useState(false);
  const [entered, setEntered] = useState(false);
  const [mouth, setMouth] = useState<MouthShape>("closed");
  const audioCtxRef = useRef<AudioContext | null>(null);
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

  // Web Speech Synthesis gives no audio node to measure, so cycle shapes on a timer.
  const startMouthCycle = useCallback(() => {
    stopMouth();
    let i = 0;
    mouthTimerRef.current = setInterval(() => {
      setMouth(FALLBACK_CYCLE[i % FALLBACK_CYCLE.length]);
      i++;
    }, 130);
  }, [stopMouth]);

  useEffect(() => stopMouth, [stopMouth]);

  // Shared ref: pending fallback timer (cleared when tts:audio arrives)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Play via Web Audio API (Google TTS base64) ---
  useEffect(() => {
    if (!audioBase64) return;

    // Cancel any pending Web Speech fallback — Google TTS takes priority
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    window.speechSynthesis?.cancel();

    const startSpeaking = () => {
      setSpeaking(true);
      onSpeakingRef.current?.(true);
    };
    const stopSpeaking = () => {
      setSpeaking(false);
      onSpeakingRef.current?.(false);
      stopMouth();
    };

    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === "closed") {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
    }

    const play = async () => {
      try {
        if (ctx!.state === "suspended") await ctx!.resume();

        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        ctx!.decodeAudioData(bytes.buffer.slice(0), (buffer) => {
          const source = ctx!.createBufferSource();
          source.buffer = buffer;

          const analyser = ctx!.createAnalyser();
          analyser.fftSize = 1024;
          const samples = new Uint8Array(analyser.fftSize);
          source.connect(analyser);
          analyser.connect(ctx!.destination);

          source.onended = stopSpeaking;
          startSpeaking();
          source.start();

          stopMouth();
          mouthTimerRef.current = setInterval(() => {
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i++) {
              const v = (samples[i] - 128) / 128;
              sum += v * v;
            }
            const next = mouthForLevel(Math.sqrt(sum / samples.length));
            setMouth((prev) => (prev === next ? prev : next));
          }, MOUTH_TICK_MS);
        }, () => {
          // decodeAudioData failed — use Web Speech as last resort
          if (fallbackTextRef.current) {
            speakWithSynthesis(fallbackTextRef.current, fallbackLangRef.current ?? "ja",
              () => { startSpeaking(); startMouthCycle(); }, stopSpeaking);
          }
        });
      } catch {
        if (fallbackTextRef.current) {
          speakWithSynthesis(fallbackTextRef.current, fallbackLangRef.current ?? "ja",
            () => { startSpeaking(); startMouthCycle(); }, stopSpeaking);
        }
      }
    };

    play();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBase64]);

  // --- Fallback: Web Speech Synthesis (when tts:audio doesn't arrive) ---
  // Uses fallbackKey (counter) so same text re-triggers correctly.
  // Waits 2s before speaking — if tts:audio arrives in that window,
  // the timer is cancelled and Google TTS plays instead (no double audio).
  const fallbackTextRef = useRef(fallbackText);
  const fallbackLangRef = useRef(fallbackLang);
  useEffect(() => { fallbackTextRef.current = fallbackText; }, [fallbackText]);
  useEffect(() => { fallbackLangRef.current = fallbackLang; }, [fallbackLang]);

  useEffect(() => {
    if (fallbackKey === undefined) return;

    // Clear any previous timer before starting a new one
    if (fallbackTimerRef.current) clearTimeout(fallbackTimerRef.current);

    fallbackTimerRef.current = setTimeout(() => {
      fallbackTimerRef.current = null;
      const text = fallbackTextRef.current;
      if (!text) return; // tts:audio arrived and cleared fallbackText → skip
      const onStart = () => { setSpeaking(true); onSpeakingRef.current?.(true); startMouthCycle(); };
      const onEnd = () => { setSpeaking(false); onSpeakingRef.current?.(false); stopMouth(); };
      speakWithSynthesis(text, fallbackLangRef.current ?? "ja", onStart, onEnd);
    }, 2000); // 2s grace period for tts:audio to arrive

    return () => {
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackKey]);

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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/avatar/mouth-${mouth}.svg`}
          alt=""
          aria-hidden="true"
          draggable={false}
          className="absolute select-none"
          style={{
            left: `${(MOUTH_CENTER_X / BASE_W) * 100}%`,
            top: `${(MOUTH_TOP_Y / BASE_H) * 100}%`,
            width: `${(MOUTH_WIDTH[mouth] / BASE_W) * 100}%`,
            transform: "translateX(-50%)",
          }}
        />
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

// Helper: speak via Web Speech Synthesis API
function speakWithSynthesis(
  text: string,
  langCode: LangCode,
  onStart: () => void,
  onEnd: () => void,
) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();

  const lang = getLang(langCode);
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang.bcp47;
  utterance.rate = 1.0;
  utterance.pitch = 1.1;

  utterance.onstart = onStart;
  utterance.onend = onEnd;
  utterance.onerror = onEnd;

  window.speechSynthesis.speak(utterance);
}
