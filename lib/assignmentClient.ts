import { Storage } from "@google-cloud/storage";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// uid → stationId[]
type AssignmentMap = Record<string, string[]>;

const GCS_PATH = "stations/assignments.json";
const LOCAL_PATH = join(process.cwd(), "stations", "assignments.json");
const TTL_MS = 5 * 60 * 1000;

let cache: { map: AssignmentMap; expiresAt: number } | null = null;

function getGCSBucket() {
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

async function readFromGCS(): Promise<AssignmentMap | null> {
  const bucket = getGCSBucket();
  if (!bucket) return null;
  try {
    const file = bucket.file(GCS_PATH);
    const [exists] = await file.exists();
    if (!exists) return {};
    const [content] = await file.download();
    return JSON.parse(content.toString()) as AssignmentMap;
  } catch {
    return null;
  }
}

async function writeToGCS(map: AssignmentMap): Promise<boolean> {
  const bucket = getGCSBucket();
  if (!bucket) return false;
  try {
    await bucket.file(GCS_PATH).save(JSON.stringify(map, null, 2), {
      contentType: "application/json",
    });
    return true;
  } catch {
    return false;
  }
}

function readFromLocal(): AssignmentMap {
  try {
    if (!existsSync(LOCAL_PATH)) return {};
    return JSON.parse(readFileSync(LOCAL_PATH, "utf-8")) as AssignmentMap;
  } catch {
    return {};
  }
}

function writeToLocal(map: AssignmentMap): void {
  const dir = join(process.cwd(), "stations");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOCAL_PATH, JSON.stringify(map, null, 2), "utf-8");
}

async function getAll(): Promise<AssignmentMap> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.map;
  const gcs = await readFromGCS();
  const map = gcs ?? readFromLocal();
  cache = { map, expiresAt: now + TTL_MS };
  return map;
}

export async function getAssignments(uid: string): Promise<string[]> {
  const map = await getAll();
  return map[uid] ?? [];
}

export async function setAssignments(uid: string, stationIds: string[]): Promise<void> {
  const map = await getAll();
  map[uid] = stationIds;
  const saved = await writeToGCS(map);
  if (!saved) writeToLocal(map);
  cache = { map, expiresAt: Date.now() + TTL_MS };
}

export function invalidateAssignmentCache(): void {
  cache = null;
}
