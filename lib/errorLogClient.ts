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

// ── 日別の保管（リリース後の不具合対応・提案④）──────────────────────────
// 管理画面が見る上の500件とは別に、全件を日ごとのファイルへも追記して残す。
// 本番の利用量では500件が数日で流れてしまい、後からの調査で遡れなくなるため。
// 書き込みは記録のたびに2回になるが、障害の発生頻度は低く（ガード類は1分に1件へ
// 間引き済み）、問題にならない。読む側の画面は無し＝調査のときにファイルを直接見る。

const jstDate = (ms: number): string => new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const archiveStores = new Map<string, ReturnType<typeof createJsonStore<AppErrorEntry[]>>>();

function archiveStoreFor(date: string) {
  let s = archiveStores.get(date);
  if (!s) {
    s = createJsonStore<AppErrorEntry[]>({
      gcsPath: `errors/archive/${date}.json`,
      localPath: join(process.cwd(), "error-log", "archive", `${date}.json`),
      empty: () => [],
    });
    archiveStores.set(date, s);
    // 日をまたいだ古い store を貯め込まない（保持は直近2日ぶんで十分）
    for (const k of archiveStores.keys()) {
      if (archiveStores.size <= 2) break;
      if (k !== date) archiveStores.delete(k);
    }
  }
  return s;
}

/** 障害履歴を日別ファイルへ追記する（消えない保管）。失敗しても呼び出し元を止めない。 */
export async function appendAppErrorArchive(entries: AppErrorEntry[]): Promise<void> {
  const byDate = new Map<string, AppErrorEntry[]>();
  for (const e of entries) {
    const d = jstDate(e.at);
    const list = byDate.get(d) ?? [];
    list.push(e);
    byDate.set(d, list);
  }
  for (const [date, items] of byDate) {
    const s = archiveStoreFor(date);
    const current = await s.getFresh();
    await s.save([...current, ...items]);
  }
}
