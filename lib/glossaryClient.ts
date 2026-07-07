import { join } from "path";
import type { GlossaryTerm } from "./types";
import { createJsonStore } from "./jsonStore";

const store = createJsonStore<GlossaryTerm[]>({
  gcsPath: "glossary/terms.json",
  localPath: join(process.cwd(), "glossary", "terms.json"),
  empty: () => [],
});

export function getGlossaryTerms(): Promise<GlossaryTerm[]> {
  return store.get();
}

/**
 * Reads the backing store directly, bypassing the in-process cache.
 * The Socket.IO server runs as a separate module instance from the Next.js API
 * routes, so it never sees invalidateGlossaryCache() calls from the admin routes.
 * It uses this fresh read so admin glossary edits reflect immediately in live
 * translation/STT instead of after the cache TTL.
 */
export function getGlossaryTermsFresh(): Promise<GlossaryTerm[]> {
  return store.getFresh();
}

export function saveGlossaryTerms(terms: GlossaryTerm[]): Promise<void> {
  return store.save(terms);
}

export function invalidateGlossaryCache(): void {
  store.invalidate();
}
