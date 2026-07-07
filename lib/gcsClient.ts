import { Storage } from "@google-cloud/storage";
import type { SessionLog, SessionSummary } from "./types";

export function getGCSBucket() {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  const bucketName = process.env.GOOGLE_STORAGE_BUCKET;
  if (!credentialsJson || !bucketName) return null;

  try {
    const credentials = JSON.parse(credentialsJson);
    const storage = new Storage({ credentials });
    return storage.bucket(bucketName);
  } catch {
    return null;
  }
}

export function isGCSEnabled(): boolean {
  return !!(
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON &&
    process.env.GOOGLE_STORAGE_BUCKET
  );
}

export async function uploadLog(
  date: string,
  sessionId: string,
  log: SessionLog
): Promise<void> {
  const bucket = getGCSBucket();
  if (!bucket) throw new Error("GCS not configured");

  await bucket
    .file(`logs/${date}/${sessionId}.json`)
    .save(JSON.stringify(log, null, 2), { contentType: "application/json" });
}

export async function listLogs(): Promise<SessionSummary[]> {
  const bucket = getGCSBucket();
  if (!bucket) return [];

  const [files] = await bucket.getFiles({ prefix: "logs/" });
  const results = await Promise.all(
    files
      .filter((f) => f.name.endsWith(".json"))
      .map(async (file) => {
        try {
          const [content] = await file.download();
          const log = JSON.parse(content.toString()) as SessionLog;
          return {
            sessionId: log.sessionId,
            machineName: log.machineName,
            userLang: log.userLang,
            startedAt: log.startedAt,
            durationSeconds: log.durationSeconds,
            messageCount: log.transcript.length,
          };
        } catch {
          return null;
        }
      })
  );

  return (results.filter(Boolean) as SessionSummary[]).sort(
    (a, b) => b.startedAt - a.startedAt
  );
}

export async function getLog(sessionId: string): Promise<SessionLog | null> {
  const bucket = getGCSBucket();
  if (!bucket) return null;

  const [files] = await bucket.getFiles({ prefix: "logs/" });
  const target = files.find((f) => f.name.endsWith(`/${sessionId}.json`));
  if (!target) return null;

  const [content] = await target.download();
  return JSON.parse(content.toString()) as SessionLog;
}
