"use client";

import type { Socket } from "socket.io-client";

/**
 * 画面のプログラムエラーをサーバーへ申告する見張り（提案②）。
 *
 * 導入後の窓処端末・係員端末は直接調べられないため、画面側で起きたエラー
 * （window.onerror / 未処理のPromise失敗）をサーバーの障害履歴へ送って残す。
 * 「画面が固まった・操作できない」という現場報告に対して、後から
 * 「その時刻に端末側で何が起きていたか」を追えるようにするのが目的。
 *
 * 連投防止（画面側）: 1分に3件まで＋同じ内容は1分に1回だけ。サーバー側にも
 * 同じ上限があるが、まず送信自体を抑えて通信を無駄にしない。
 *
 * 戻り値は解除関数（画面を離れるときに呼ぶ）。
 */
export function installClientErrorReporter(
  getSocket: () => Socket | null,
  page: "user" | "staff",
  getMachineName?: () => string | undefined,
): () => void {
  let windowStart = 0;
  let count = 0;
  const recent = new Map<string, number>(); // 内容 → 最後に送った時刻

  const report = (detail: string) => {
    const now = Date.now();
    if (now - windowStart > 60_000) { windowStart = now; count = 0; }
    if (++count > 3) return;
    const key = detail.slice(0, 120);
    const last = recent.get(key);
    if (last && now - last < 60_000) return; // 同じエラーの繰り返しは間引く
    recent.set(key, now);
    try {
      getSocket()?.emit("client:error", {
        page,
        machineName: getMachineName?.(),
        detail: detail.slice(0, 300),
      });
    } catch { /* 報告のためにさらに壊れない */ }
  };

  const onError = (event: ErrorEvent) => {
    // リソース読み込みの失敗などmessageが無いものは対象外（ノイズ抑制）
    if (!event.message) return;
    const where = event.filename ? ` @${event.filename.split("/").pop()}:${event.lineno}` : "";
    report(`${event.message}${where}`);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const r = event.reason;
    const msg = r instanceof Error ? `${r.name}: ${r.message}` : String(r);
    report(`未処理のPromise失敗: ${msg}`);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
