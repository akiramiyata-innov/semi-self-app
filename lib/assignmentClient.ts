import { join } from "path";
import { createJsonStore } from "./jsonStore";

// uid → stationId[]
type AssignmentMap = Record<string, string[]>;

const store = createJsonStore<AssignmentMap>({
  gcsPath: "stations/assignments.json",
  localPath: join(process.cwd(), "stations", "assignments.json"),
  empty: () => ({}),
});

export async function getAssignments(uid: string): Promise<string[]> {
  const map = await store.get();
  return map[uid] ?? [];
}

/**
 * Reads assignments directly, bypassing the in-process cache — used by the
 * Socket.IO server (a separate module instance from the Next.js API routes) so a
 * staff member's station changes take effect immediately on their next
 * (re)connect instead of after the cache TTL.
 */
export async function getAssignmentsFresh(uid: string): Promise<string[]> {
  const map = await store.getFresh();
  return map[uid] ?? [];
}

export async function setAssignments(uid: string, stationIds: string[]): Promise<void> {
  const map = await store.get();
  map[uid] = stationIds;
  await store.save(map);
}

export function invalidateAssignmentCache(): void {
  store.invalidate();
}
