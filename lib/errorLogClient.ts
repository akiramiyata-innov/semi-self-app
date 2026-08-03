import { join } from "path";
import type { AppErrorEntry } from "./types";
import { createJsonStore } from "./jsonStore";

// 障害履歴の保存先。GCS（本番）またはローカルファイル（開発）。
// 通話ログと同じく「新しい保存機構を作らない」方針で既存の JsonStore に載せる。
const store = createJsonStore<AppErrorEntry[]>({
  gcsPath: "errors/error-log.json",
  localPath: join(process.cwd(), "error-log", "error-log.json"),
  empty: () => [],
});

/** 保持する最大件数（古いものから消える） */
export const ERROR_LOG_MAX = 500;

/**
 * 障害履歴を読む（キャッシュなし）。
 * Socket.IO サーバーと API ルートはモジュールの実体が別で、書き込みは
 * Socket.IO サーバー側からしか起きないため、API 側は常に最新を読む。
 */
export function getAppErrorsFresh(): Promise<AppErrorEntry[]> {
  return store.getFresh();
}

/** 障害履歴を保存する（recordAppError の flush 用。直接は使わない）。 */
export async function saveAppErrors(entries: AppErrorEntry[]): Promise<void> {
  await store.save(entries.slice(-ERROR_LOG_MAX));
}
