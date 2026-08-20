/**
 * 窓処サーバの代わりをする、確認用の受け取りサーバ。
 *
 *   node scripts/kiosk-notify/mock-kiosk-server.mjs            # 8080番で待ち受け
 *   PORT=9000 node scripts/kiosk-notify/mock-kiosk-server.mjs  # 番号を変える
 *
 * 通話が終わったときに、お客様画面（窓処端末のブラウザ）から
 *   GET http://localhost:8080?type=CALL_ENDED&status=ended&route=client-call&ts=...&ver=1
 * が飛んでくる。それを受けて画面に出すだけの、中身のないサーバー。
 *
 * ★窓処側から示された通信方式に合わせてある（2026-08-20）
 *   ・プロトコル : HTTP GET
 *   ・送信先     : http://localhost:8080（パスは付けない＝ルート）
 *   ・データ形式 : クエリパラメータ（key=value）
 *   ・type で処理を切り替える
 *
 * 【何のためにあるか】
 *   ・本物の窓処サーバができる前に、遠隔接客アプリ側の実装を確かめられる
 *   ・窓処端末アプリの開発担当者に「こういうGETが飛びます」と実物で示せる
 *   ・実機で「HTTPSのページから localhost が呼べるか」を確かめられる
 *     （ブラウザによっては遮断されることがあり、そこが最大の未確認事項）
 *
 * 【本物の窓処サーバに必要なこと】
 *   ・GET を受けて 200 を返すだけでよい（応答の中身は使われない）
 *   ・お客様画面は「投げっぱなし」で送るため、CORSの設定は不要
 *   ・ただし Chrome の Private Network Access に引っかかる場合は、
 *     プリフライト（OPTIONS）に Access-Control-Allow-Private-Network: true を返す必要がある。
 *     このサーバーはその応答も返すようにしてある（下の handlePreflight を参照）。
 */
import http from "node:http";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 8080);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, "received.log");

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Chrome の Private Network Access への応答。
 * インターネット上のページから端末内（localhost）への通信は、ブラウザが事前に
 * OPTIONS で「入っていいか」を尋ねてくることがある。許可を返さないと本番の
 * GET が届かない。本物の窓処サーバでも同じ応答が要る場合がある。
 */
function handlePreflight(req, res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Max-Age": "600",
  });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") {
    console.log(`[${stamp()}] ← OPTIONS ${url.pathname}（ブラウザの事前確認）`);
    return handlePreflight(req, res);
  }

  // 窓処側の仕様では、パスを付けずルート（/）へクエリパラメータで送られてくる。
  // type が付いていれば通知とみなす（/call-ended も従来どおり受ける）。
  const q = Object.fromEntries(url.searchParams);
  if (q.type || url.pathname === "/call-ended") {
    const line =
      `[${stamp()}] ★通知を受け取りました  ${url.pathname}${url.search}\n` +
      `    type   : ${q.type ?? "(なし)"}      ← 窓処側はこれで処理を切り替える\n` +
      `    status : ${q.status ?? "(なし)"}    ← 終了の理由\n` +
      `    route  : ${q.route ?? "(なし)"}\n` +
      `    端末ID : ${q.machine ?? "(なし)"}\n` +
      `    通話ID : ${q.session ?? "(なし)"}\n` +
      `    ts     : ${q.ts ? new Date(Number(q.ts)).toLocaleString("ja-JP") : "(なし)"}\n` +
      `    ver    : ${q.ver ?? "(なし)"}\n` +
      `    → 本物の窓処サーバは、ここで窓処端末の画面を待機画面に戻す\n`;
    console.log(line);
    await appendFile(LOG, line, "utf8").catch(() => {});
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": req.headers.origin ?? "*",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
    });
    return res.end("ok");
  }

  if (url.pathname === "/" || url.pathname === "/health") {   // type 無しでルートに来た場合
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(
      `窓処サーバ（確認用）が動いています。\n` +
      `通話終了の通知はこちらへ: http://localhost:${PORT}?type=CALL_ENDED&status=ended&…\n` +
      `記録: ${LOG}\n`);
  }

  console.log(`[${stamp()}] ← ${req.method} ${url.pathname}（知らない宛先）`);
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("─".repeat(64));
  console.log(`窓処サーバ（確認用）を ${PORT} 番で起動しました`);
  console.log(`  受け取る宛先 : http://localhost:${PORT}（パスなし・クエリパラメータで受ける）`);
  console.log(`  記録ファイル : ${LOG}`);
  console.log("");
  console.log("お客様画面のURLに、次のように通知先を付けて開いてください：");
  console.log(`  …/user?machine=kiosk-1&name=券売機1番&station=…&notify=http://localhost:${PORT}`);
  console.log("");
  console.log("止めるときは Ctrl+C");
  console.log("─".repeat(64));
});
