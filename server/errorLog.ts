// 障害の記録係。サーバー内の異常発生点から recordAppError() を呼ぶと、
// 数秒まとめてから保存する（発生のたびに書くとSTTガードの連続破棄などで
// 書き込みが暴れるため）。保存の失敗で通話処理を巻き添えにしない。
import type { AppErrorEntry } from "../lib/types";
import { getAppErrorsFresh, saveAppErrors } from "../lib/errorLogClient";

const FLUSH_DELAY_MS = 3000;
const pending: AppErrorEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function recordAppError(entry: Omit<AppErrorEntry, "at">): void {
  pending.push({ at: Date.now(), ...entry });
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }
}

async function flush(): Promise<void> {
  const items = pending.splice(0, pending.length);
  if (items.length === 0) return;
  try {
    const current = await getAppErrorsFresh();
    await saveAppErrors([...current, ...items]);
  } catch (e) {
    // 記録に失敗しても本体の動作は続ける（コンソールには残す）
    console.error("[error-log] 障害履歴の保存に失敗:", e);
  }
}
