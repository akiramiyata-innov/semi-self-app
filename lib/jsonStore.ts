import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { getGCSBucket } from "./gcsClient";

/**
 * A small JSON document store backed by Google Cloud Storage (when configured)
 * with a local-file fallback and an in-process TTL cache.
 *
 * Shared by the glossary / station / staff-assignment data modules, which were
 * previously three near-identical copies of this logic.
 *
 * Note: the Socket.IO server runs as a separate module instance from the Next.js
 * API routes, so its cache never sees invalidate() calls made by the routes. Use
 * getFresh() there to always read the latest.
 */
export interface JsonStore<T> {
  /** Cached read (refreshes after the TTL). */
  get(): Promise<T>;
  /** Uncached read — always hits the backing store. */
  getFresh(): Promise<T>;
  /** Persist and refresh the cache. */
  save(data: T): Promise<void>;
  /** Drop the cached value so the next get() reloads. */
  invalidate(): void;
}

interface JsonStoreConfig<T> {
  /** Object path within the GCS bucket, e.g. "glossary/terms.json". */
  gcsPath: string;
  /** Absolute local file path used when GCS is not configured or write fails. */
  localPath: string;
  /** Produces a fresh empty value (new object each call — never shared/mutated). */
  empty: () => T;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function createJsonStore<T>({
  gcsPath,
  localPath,
  empty,
  ttlMs = DEFAULT_TTL_MS,
}: JsonStoreConfig<T>): JsonStore<T> {
  let cache: { data: T; expiresAt: number } | null = null;

  async function readFromGCS(): Promise<T | null> {
    const bucket = getGCSBucket();
    if (!bucket) return null;
    try {
      const file = bucket.file(gcsPath);
      const [exists] = await file.exists();
      if (!exists) return empty();
      const [content] = await file.download();
      return JSON.parse(content.toString()) as T;
    } catch {
      return null;
    }
  }

  async function writeToGCS(data: T): Promise<boolean> {
    const bucket = getGCSBucket();
    if (!bucket) return false;
    try {
      await bucket.file(gcsPath).save(JSON.stringify(data, null, 2), {
        contentType: "application/json",
      });
      return true;
    } catch {
      return false;
    }
  }

  function readFromLocal(): T {
    try {
      if (!existsSync(localPath)) return empty();
      return JSON.parse(readFileSync(localPath, "utf-8")) as T;
    } catch {
      return empty();
    }
  }

  function writeToLocal(data: T): void {
    const dir = dirname(localPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(localPath, JSON.stringify(data, null, 2), "utf-8");
  }

  async function load(): Promise<T> {
    const gcs = await readFromGCS();
    return gcs ?? readFromLocal();
  }

  return {
    async get(): Promise<T> {
      const now = Date.now();
      if (cache && cache.expiresAt > now) return cache.data;
      const data = await load();
      cache = { data, expiresAt: now + ttlMs };
      return data;
    },
    getFresh(): Promise<T> {
      return load();
    },
    async save(data: T): Promise<void> {
      const saved = await writeToGCS(data);
      if (!saved) writeToLocal(data);
      cache = { data, expiresAt: Date.now() + ttlMs };
    },
    invalidate(): void {
      cache = null;
    },
  };
}
