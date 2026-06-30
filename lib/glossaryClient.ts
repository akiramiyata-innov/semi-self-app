import { Storage } from "@google-cloud/storage";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { GlossaryTerm } from "./types";

const GLOSSARY_PATH = "glossary/terms.json";
const LOCAL_PATH = join(process.cwd(), "glossary", "terms.json");
const TTL_MS = 5 * 60 * 1000;

let cache: { terms: GlossaryTerm[]; expiresAt: number } | null = null;

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

async function readFromGCS(): Promise<GlossaryTerm[] | null> {
  const bucket = getGCSBucket();
  if (!bucket) return null;
  try {
    const file = bucket.file(GLOSSARY_PATH);
    const [exists] = await file.exists();
    if (!exists) return [];
    const [content] = await file.download();
    return JSON.parse(content.toString()) as GlossaryTerm[];
  } catch {
    return null;
  }
}

async function writeToGCS(terms: GlossaryTerm[]): Promise<boolean> {
  const bucket = getGCSBucket();
  if (!bucket) return false;
  try {
    await bucket.file(GLOSSARY_PATH).save(JSON.stringify(terms, null, 2), {
      contentType: "application/json",
    });
    return true;
  } catch {
    return false;
  }
}

function readFromLocal(): GlossaryTerm[] {
  try {
    if (!existsSync(LOCAL_PATH)) return [];
    return JSON.parse(readFileSync(LOCAL_PATH, "utf-8")) as GlossaryTerm[];
  } catch {
    return [];
  }
}

function writeToLocal(terms: GlossaryTerm[]): void {
  const dir = join(process.cwd(), "glossary");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOCAL_PATH, JSON.stringify(terms, null, 2), "utf-8");
}

export async function getGlossaryTerms(): Promise<GlossaryTerm[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.terms;

  const gcs = await readFromGCS();
  const terms = gcs ?? readFromLocal();
  cache = { terms, expiresAt: now + TTL_MS };
  return terms;
}

export async function saveGlossaryTerms(terms: GlossaryTerm[]): Promise<void> {
  const saved = await writeToGCS(terms);
  if (!saved) writeToLocal(terms);
  cache = { terms, expiresAt: Date.now() + TTL_MS };
}

export function invalidateGlossaryCache(): void {
  cache = null;
}
