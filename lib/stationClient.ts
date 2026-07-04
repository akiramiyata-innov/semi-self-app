import { Storage } from "@google-cloud/storage";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { Station } from "./types";

const GCS_PATH = "stations/master.json";
const LOCAL_PATH = join(process.cwd(), "stations", "master.json");
const TTL_MS = 5 * 60 * 1000;

let cache: { stations: Station[]; expiresAt: number } | null = null;

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

async function readFromGCS(): Promise<Station[] | null> {
  const bucket = getGCSBucket();
  if (!bucket) return null;
  try {
    const file = bucket.file(GCS_PATH);
    const [exists] = await file.exists();
    if (!exists) return [];
    const [content] = await file.download();
    return JSON.parse(content.toString()) as Station[];
  } catch {
    return null;
  }
}

async function writeToGCS(stations: Station[]): Promise<boolean> {
  const bucket = getGCSBucket();
  if (!bucket) return false;
  try {
    await bucket.file(GCS_PATH).save(JSON.stringify(stations, null, 2), {
      contentType: "application/json",
    });
    return true;
  } catch {
    return false;
  }
}

function readFromLocal(): Station[] {
  try {
    if (!existsSync(LOCAL_PATH)) return [];
    return JSON.parse(readFileSync(LOCAL_PATH, "utf-8")) as Station[];
  } catch {
    return [];
  }
}

function writeToLocal(stations: Station[]): void {
  const dir = join(process.cwd(), "stations");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOCAL_PATH, JSON.stringify(stations, null, 2), "utf-8");
}

export async function getStations(): Promise<Station[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.stations;
  const gcs = await readFromGCS();
  const stations = gcs ?? readFromLocal();
  cache = { stations, expiresAt: now + TTL_MS };
  return stations;
}

export async function saveStations(stations: Station[]): Promise<void> {
  const saved = await writeToGCS(stations);
  if (!saved) writeToLocal(stations);
  cache = { stations, expiresAt: Date.now() + TTL_MS };
}

export function invalidateStationCache(): void {
  cache = null;
}
