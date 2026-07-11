"use client";

/**
 * A single shared Web Audio context for the kiosk, plus a way to "unlock" it.
 *
 * Browsers block audio that isn't started from within a user gesture. The staff's
 * TTS arrives over a socket (not a gesture), so the context must be created and
 * resumed while the user is tapping — otherwise it stays suspended and nothing
 * plays. Call unlockAudioContext() from the tap handlers (language select, call
 * button); the Avatar then reuses this same, already-running context.
 */

let sharedCtx: AudioContext | null = null;

function AudioCtxClass(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

/** The shared context, created on first use. May be "suspended" until unlocked. */
export function getSharedAudioContext(): AudioContext | null {
  const Ctor = AudioCtxClass();
  if (!Ctor) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/**
 * Unlock audio playback. MUST be called synchronously from a user-gesture handler
 * (onClick/onTouch). Creates the shared context if needed and resumes it so later
 * socket-driven audio can play.
 */
export function unlockAudioContext(): void {
  const ctx = getSharedAudioContext();
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => { /* will retry on the next gesture */ });
  }
}
