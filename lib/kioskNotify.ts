/**
 * 窓処サーバへの「通話が終わった」通知（2026-08-20）。
 *
 * 【なぜブラウザから送るのか】
 *   窓処サーバは窓処端末そのもの（localhost）で動いている。遠隔接客サーバ
 *   （Railway＝インターネット上）から見た localhost は Railway 自身なので届かない。
 *   窓処端末で動いているのは**お客様画面のブラウザ**だけなので、ここから送る。
 *   係員が終了した場合も、いったんお客様画面が受け取ってから送る（経路が1本に集まる）。
 *
 * 【窓処側から示された通信方式】
 *   ・HTTP GET ／ 送信先 http://localhost:8080（パスなし）／ クエリパラメータ
 *   ・窓処側は **type だけを見て**処理を切り替える
 *       type=INITIALIZED → 通話画面に切り替える
 *       type=CALL_ENDED  → 通話終了と判断し、待機画面に戻す
 *
 *   したがって終わり方が7種類あっても**すべて type=CALL_ENDED で送る**。
 *   どの終わり方だったかは status に入れる。**窓処側は status を見なくてよい**が、
 *   後から遠隔接客側の通話ログと突き合わせるために付けている。
 *
 * 【応答について】
 *   投げっぱなしで送るため、応答の中身は使わない。窓処サーバは 200 を返すだけでよい。
 */

/** 通話の終わり方。窓処側の処理は同じ（待機画面へ戻す）で、記録用の区別。 */
export type CallEndStatus =
  | "ended"                // どちらかが「通話終了」を押した（同じ端末からの再呼び出しもこれ）
  | "rejected"             // 係員が応答を断った
  | "no-staff"             // 応答できる係員がいなかった
  | "call-timeout"         // 誰も応答しないまま打ち切り時間が過ぎた
  | "staff-disconnected"   // 通話中に係員の接続が切れた
  | "user-offline";        // 通話中にお客様側（窓処端末）の通信が切れた

export const NOTIFY_TYPE_CALL_ENDED = "CALL_ENDED";
/** 窓処側の例（type=INITIALIZED…&route=client-call）に合わせた値。 */
export const NOTIFY_ROUTE = "client-call";
export const NOTIFY_VER = "1";

/**
 * 通知先として認めるのは**その端末自身**だけ。
 *
 * 通知先はお客様画面のURL（?notify=…）で渡すため、そのまま信じると、細工した
 * URLで端末を開かせて外部のサーバへ通話の記録を送らせることができてしまう。
 * localhost 以外は受け付けない。
 */
export function sanitizeNotifyBase(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, "");   // [::1] の角かっこを外す
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") return undefined;
  return u.toString();
}

interface NotifyArgs {
  /** sanitizeNotifyBase を通した通知先。未設定なら何もしない。 */
  base: string | undefined;
  status: CallEndStatus;
  machineId?: string;
  sessionId?: string | null;
  /** 追加のパラメータ（確認用ページが試行の目印を足すために使う）。 */
  extra?: Record<string, string>;
}

/**
 * 実際に送るURLを組み立てる。
 * **確認用ページ（/kiosk-notify-test）も同じこの関数を使う**ので、
 * 実機で確かめた形と本番で送る形がずれない。
 */
export function buildNotifyUrl({ base, status, machineId, sessionId, extra }: NotifyArgs): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    u.searchParams.set("type", NOTIFY_TYPE_CALL_ENDED);
    u.searchParams.set("status", status);
    u.searchParams.set("route", NOTIFY_ROUTE);
    if (machineId) u.searchParams.set("machine", machineId);
    if (sessionId) u.searchParams.set("session", sessionId);
    u.searchParams.set("ts", String(Date.now()));
    u.searchParams.set("ver", NOTIFY_VER);
    for (const [k, v] of Object.entries(extra ?? {})) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * 通話終了を窓処サーバへ知らせる。**送れなくても通話の動作には影響させない**
 * （窓処端末アプリ側には別途、無通信の見張りが必要）。
 */
export function notifyCallEnded(args: NotifyArgs): void {
  if (typeof window === "undefined") return;
  const url = buildNotifyUrl(args);
  if (!url) return;

  // ①fetch で送る。届いたかどうかが分かるので、実機での確認に使える。
  //   no-cors なので応答は読めないが、窓処側の CORS 設定は不要になる。
  // ②ブラウザに遮断された場合の保険として画像の読み込みで送る。
  //   （画像は CORS や Private Network Access の制限を受けにくい）
  fetch(url, { mode: "no-cors", cache: "no-store", keepalive: true })
    .then(() => console.info(`[窓処通知] 送信しました status=${args.status}`))
    .catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      console.warn(`[窓処通知] fetchで送れませんでした（${why}）。画像読み込みで再送します`);
      const img = new Image();
      img.src = url;
    });
}
