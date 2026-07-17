import type { v2 } from "@google-cloud/speech";

// Google Cloud Speech-to-Text **V2** client, used for streaming recognition with
// the dictionary (model adaptation).
//
// Why V2 (not V1): the classic V1 phrase hints (speechContexts) had *no*
// measurable effect on recognition (verified: 馬喰横山 stayed 暴露横山 even at max
// boost). V2 inline model adaptation with the chirp_2 model *does* correct domain
// terms (verified end-to-end, sync + streaming).
//
// Auth: V2 recognize requires an IAM identity — API keys are rejected with
// "permission denied 'speech.recognizers.recognize'". So it authenticates with the
// Firebase service account already in the environment; that SA holds the Cloud
// Speech role on SPEECH_PROJECT.
//
// The @google-cloud/speech package (native gRPC deps) is imported lazily so it
// only loads the first time streaming is actually used — when streaming is
// disabled (NEXT_PUBLIC_STT_MODE!=="streaming") a dependency issue can't break
// server startup.

// Project that has Speech-to-Text + billing enabled and that the SA can access.
// (The app's own project can't enable Speech yet due to a billing-project quota;
// override via env once that's resolved.)
export const SPEECH_PROJECT = process.env.GOOGLE_SPEECH_PROJECT || "nihonshingo-proposal";
// Region must host the chirp_2 model. asia-northeast1 = Tokyo (low latency for JP).
export const SPEECH_REGION = process.env.GOOGLE_SPEECH_REGION || "asia-northeast1";
export const SPEECH_MODEL = process.env.GOOGLE_SPEECH_MODEL || "chirp_2";

/** Full resource name of the default (inline-config) recognizer. */
export const RECOGNIZER = `projects/${SPEECH_PROJECT}/locations/${SPEECH_REGION}/recognizers/_`;

let client: v2.SpeechClient | null = null;

// Normalize FIREBASE_PRIVATE_KEY to real PEM regardless of how it's stored
// (surrounding quotes / \n or \r\n escapes / base64). Mirrors loadPrivateKey in
// lib/firebase-admin.ts — kept local so this module stays decoupled from Firebase
// admin init. server.ts's minimal .env.local parser can leave the quotes on.
function normalizePrivateKey(raw: string): string {
  let k = (raw ?? "").trim();
  if (k.length >= 2 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) {
    k = k.slice(1, -1);
  }
  if (!k.includes("BEGIN")) {
    try { const d = Buffer.from(k, "base64").toString("utf8"); if (d.includes("BEGIN")) k = d; } catch { /* not base64 */ }
  }
  return k.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

/** Shared Speech V2 client (service-account auth), or null when creds are missing. */
export async function getSpeechClient(): Promise<v2.SpeechClient | null> {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY ?? "");
  if (!clientEmail || !privateKey.includes("BEGIN")) return null;
  if (!client) {
    const { v2 } = await import("@google-cloud/speech");
    client = new v2.SpeechClient({
      credentials: { client_email: clientEmail, private_key: privateKey },
      projectId: SPEECH_PROJECT,
      apiEndpoint: `${SPEECH_REGION}-speech.googleapis.com`,
    });
  }
  return client;
}
