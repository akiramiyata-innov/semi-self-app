"use client";

import { useEffect, useRef, useState } from "react";
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
  size?: "sm" | "md" | "lg";
}

const SIZE_MAP = { sm: 120, md: 200, lg: 280 };

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
  const audioCtxRef = useRef<AudioContext | null>(null);
  const onSpeakingRef = useRef(onSpeakingChange);
  const dim = SIZE_MAP[size];

  useEffect(() => { onSpeakingRef.current = onSpeakingChange; }, [onSpeakingChange]);

  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setEntered(true), 50);
      return () => clearTimeout(t);
    } else {
      setEntered(false);
    }
  }, [visible]);

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
          source.connect(ctx!.destination);
          source.onended = stopSpeaking;
          startSpeaking();
          source.start();
        }, () => {
          // decodeAudioData failed — use Web Speech as last resort
          if (fallbackTextRef.current) {
            speakWithSynthesis(fallbackTextRef.current, fallbackLangRef.current ?? "ja", startSpeaking, stopSpeaking);
          }
        });
      } catch {
        if (fallbackTextRef.current) {
          speakWithSynthesis(fallbackTextRef.current, fallbackLangRef.current ?? "ja", startSpeaking, stopSpeaking);
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
      const onStart = () => { setSpeaking(true); onSpeakingRef.current?.(true); };
      const onEnd = () => { setSpeaking(false); onSpeakingRef.current?.(false); };
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
    speaking ? "avatar-talking" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col items-center gap-3">
      <div className={containerClass} style={{ width: dim, height: dim }}>
        <svg
          width={dim}
          height={dim}
          viewBox="0 0 100 100"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="駅員アバター"
        >
          {/* Body / uniform */}
          <rect x="25" y="55" width="50" height="40" rx="5" fill="#1e3a5f" />
          {/* White shirt collar */}
          <polygon points="50,55 42,70 50,65 58,70" fill="white" />
          {/* Tie */}
          <polygon points="50,65 47,80 50,82 53,80" fill="#c0392b" />
          {/* Head */}
          <ellipse cx="50" cy="38" rx="20" ry="22" fill="#f5cba7" />
          {/* Cap brim */}
          <rect x="28" y="20" width="44" height="6" rx="3" fill="#1e3a5f" />
          <rect x="22" y="23" width="56" height="4" rx="2" fill="#1e3a5f" />
          {/* Cap badge */}
          <circle cx="50" cy="20" r="3" fill="#f1c40f" />
          {/* Eyes */}
          <ellipse cx="42" cy="38" rx="3.5" ry="3.5" fill="white" />
          <ellipse cx="58" cy="38" rx="3.5" ry="3.5" fill="white" />
          <circle cx="43" cy="38" r="2" fill="#2c3e50" />
          <circle cx="59" cy="38" r="2" fill="#2c3e50" />
          <circle cx="43.8" cy="37.2" r="0.8" fill="white" />
          <circle cx="59.8" cy="37.2" r="0.8" fill="white" />
          {/* Eyebrows */}
          <path d="M 38.5 33.5 Q 42 32 45.5 33.5" stroke="#5d4037" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M 54.5 33.5 Q 58 32 61.5 33.5" stroke="#5d4037" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          {/* Nose */}
          <ellipse cx="50" cy="43" rx="1.5" ry="1" fill="#e8a87c" />
          {/* Mouth */}
          {speaking ? (
            <ellipse cx="50" cy="50" rx="6" ry="4" fill="#c0392b" />
          ) : (
            <path
              className="mouth-path"
              d="M 44 49 Q 50 53 56 49"
              stroke="#c0392b"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
            />
          )}
          {/* Ears */}
          <ellipse cx="30" cy="40" rx="3" ry="4" fill="#f5cba7" />
          <ellipse cx="70" cy="40" rx="3" ry="4" fill="#f5cba7" />
          {/* Arms */}
          <rect x="10" y="58" width="17" height="8" rx="4" fill="#1e3a5f" />
          <rect x="73" y="58" width="17" height="8" rx="4" fill="#1e3a5f" />
          {/* Hands */}
          <circle cx="10" cy="62" r="5" fill="#f5cba7" />
          <circle cx="90" cy="62" r="5" fill="#f5cba7" />
        </svg>
      </div>
      <div className="text-center">
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
