import { join } from "path";
import type { Station } from "./types";
import { createJsonStore } from "./jsonStore";

const store = createJsonStore<Station[]>({
  gcsPath: "stations/master.json",
  localPath: join(process.cwd(), "stations", "master.json"),
  empty: () => [],
});

export function getStations(): Promise<Station[]> {
  return store.get();
}

export function saveStations(stations: Station[]): Promise<void> {
  return store.save(stations);
}

export function invalidateStationCache(): void {
  store.invalidate();
}
