import { join } from "path";
import { createJsonStore } from "./jsonStore";

// uid → 定型文（送信順に並んだ文字列の配列）
type QuickReplyMap = Record<string, string[]>;

const store = createJsonStore<QuickReplyMap>({
  gcsPath: "quick-replies/quick-replies.json",
  localPath: join(process.cwd(), "quick-replies", "quick-replies.json"),
  empty: () => ({}),
});

export async function getQuickReplies(uid: string): Promise<string[]> {
  const map = await store.get();
  return map[uid] ?? [];
}

export async function setQuickReplies(uid: string, phrases: string[]): Promise<void> {
  const map = await store.get();
  map[uid] = phrases;
  await store.save(map);
}
