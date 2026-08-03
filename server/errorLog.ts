// 障害の記録係。サーバー内の異常発生点から recordAppError() を呼ぶと、
// 数秒まとめてから保存する（発生のたびに書くとSTTガードの連続破棄などで
// 書き込みが暴れるため）。保存の失敗で通話処理を巻き添えにしない。
import type { AppErrorEntry } from "../lib/types";
import { getAppErrorsFresh, saveAppErrors } from "../lib/errorLogClient";

const FLUSH_DELAY_MS = 3000;
const pending: AppErrorEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 通信相手（socket）が誰なのかを表す情報。記録に「どの端末・どちら側・どの係員か」を添えるために使う。 */
export interface SocketContext {
  sessionId?: string;
  machineName?: string;
  staffName?: string;
  side?: "user" | "staff";
}

// 音声認識（sttStream）は socket しか持たず、通話や係員のことを知らない。
// socketServer だけが対応表を持っているので、解決関数を登録してもらう。
let resolveSocket: (socketId: string) => SocketContext = () => ({});

export function setSocketContextResolver(fn: (socketId: string) => SocketContext): void {
  resolveSocket = fn;
}

/**
 * socket から分かる情報（通話・端末名・係員名・お客様/係員の別）を自動で添えて記録する。
 * 呼び出し側で明示した項目のほうが優先される。
 */
export function recordSocketError(socketId: string, entry: Omit<AppErrorEntry, "at">): void {
  recordAppError({ ...resolveSocket(socketId), ...entry });
}

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
