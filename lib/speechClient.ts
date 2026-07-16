import { SpeechClient } from "@google-cloud/speech";

// The gRPC streaming API authenticates with the same API key the REST STT/TTS
// already use (verified: streamingRecognize works with { apiKey }). No service
// account or extra IAM grant is needed.
let client: SpeechClient | null = null;

/** Shared Google Speech client, or null when no API key is configured. */
export function getSpeechClient(): SpeechClient | null {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === "your_google_api_key_here") return null;
  if (!client) client = new SpeechClient({ apiKey });
  return client;
}
