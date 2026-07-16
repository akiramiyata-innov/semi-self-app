import type { SpeechClient } from "@google-cloud/speech";

// The gRPC streaming API authenticates with the same API key the REST STT/TTS
// already use (verified: streamingRecognize works with { apiKey }). No service
// account or extra IAM grant is needed.
//
// The @google-cloud/speech package (with its gRPC native deps) is imported lazily
// so it only loads the first time streaming is actually used. When streaming is
// disabled (NEXT_PUBLIC_STT_MODE!=="streaming"), it never loads — a dependency
// issue can't break server startup.
let client: SpeechClient | null = null;

/** Shared Google Speech client, or null when no API key is configured. */
export async function getSpeechClient(): Promise<SpeechClient | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === "your_google_api_key_here") return null;
  if (!client) {
    const { SpeechClient } = await import("@google-cloud/speech");
    client = new SpeechClient({ apiKey });
  }
  return client;
}
