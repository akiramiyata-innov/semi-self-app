"use client";

/**
 * 窓処サーバへの通知が、実機のブラウザで通るかを確かめるページ（2026-08-20）。
 *
 * 【なぜ必要か】
 *   お客様画面は HTTPS（インターネット上）で動くが、窓処サーバは端末内（localhost）にある。
 *   ブラウザによっては、この向きの通信を遮断する（Chrome の Private Network Access ほか）。
 *   **これは窓処端末の実物でしか確かめられない**ため、開発者ツールを使わずに
 *   ボタン1つで試せる形にした。
 *
 * 【設計の要点】
 *   ・送信は本番と同じ buildNotifyUrl を使う。**確かめた形と本番で送る形をずらさない**
 *   ・宛先は端末自身（localhost）に限る。他所へ送らせないため sanitizeNotifyBase を通す
 *   ・**届いたかどうかはブラウザ側では分からない**（応答を読めない送り方のため）。
 *     判定は窓処サーバのログで行う。その旨を画面にも明記している
 *   ・結果はそのまま報告できるよう、コピーできるようにしてある
 */

import { useCallback, useRef, useState } from "react";
import { buildNotifyUrl, sanitizeNotifyBase } from "@/lib/kioskNotify";

type Verdict = "ok" | "ng" | "unknown";

interface Line {
  label: string;
  verdict: Verdict;
  detail: string;
}

const MARK: Record<Verdict, string> = { ok: "○", ng: "×", unknown: "△" };
const COLOR: Record<Verdict, string> = {
  ok: "bg-green-100 border-green-500 text-green-900",
  ng: "bg-red-100 border-red-500 text-red-900",
  unknown: "bg-yellow-100 border-yellow-500 text-yellow-900",
};

/** 画像の読み込みは、成功しても失敗しても同じように終わる（応答が画像ではないため）。 */
function sendByImage(url: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    const done = (how: string) => resolve(how);
    img.onload = () => done("読み込みが完了した");
    img.onerror = () => done("読み込みは失敗した（応答が画像ではないため、遮断されたかどうかはこれでは分からない）");
    img.src = url;
    setTimeout(() => done("5秒たっても終わらなかった"), 5000);
  });
}

export default function KioskNotifyTestPage() {
  const [base, setBase] = useState("http://localhost:8080");
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  // 報告文は押されたときに作る（画面を出した時点では window を見ない＝表示のずれを避ける）。
  const [report, setReport] = useState("");
  const tryRef = useRef(0);

  const run = useCallback(async () => {
    const clean = sanitizeNotifyBase(base);
    if (!clean) {
      setLines([{
        label: "宛先の指定",
        verdict: "ng",
        detail: "この画面から送れるのは端末自身（localhost / 127.0.0.1）だけです。宛先を確認してください。",
      }]);
      setSent([]);
      return;
    }

    setRunning(true);
    setCopied(false);
    const n = ++tryRef.current;
    const out: Line[] = [];
    const urls: string[] = [];

    // ①本番と同じ送り方（fetch）
    const fetchUrl = buildNotifyUrl({
      base: clean, status: "ended", machineId: "notify-test",
      extra: { via: "fetch", try: String(n) },
    });
    if (fetchUrl) {
      urls.push(fetchUrl);
      try {
        await fetch(fetchUrl, { mode: "no-cors", cache: "no-store" });
        out.push({
          label: "① 通常の送信（fetch）",
          verdict: "ok",
          detail: "ブラウザに遮断されませんでした。窓処サーバのログに届いているはずです。",
        });
      } catch (e) {
        out.push({
          label: "① 通常の送信（fetch）",
          verdict: "ng",
          detail: `ブラウザに遮断されました。エラー内容：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    setLines([...out]);

    // ②①が弾かれたときの保険（画像の読み込み）
    const imgUrl = buildNotifyUrl({
      base: clean, status: "ended", machineId: "notify-test",
      extra: { via: "img", try: String(n) },
    });
    if (imgUrl) {
      urls.push(imgUrl);
      const how = await sendByImage(imgUrl);
      out.push({
        label: "② 保険の送信（画像の読み込み）",
        verdict: "unknown",
        detail: `送信を試みました（${how}）。届いたかどうかは窓処サーバのログでご確認ください。`,
      });
    }

    // ③端末内への通信に許可が要るブラウザかどうか（分かる場合だけ、参考として出す）。
    //   ★①が成功していれば、ここが granted 以外でも問題ない。
    //     このページを端末内（localhost）から開いた場合、そもそも許可の対象外なのに
    //     denied と出ることがあるため、失敗の判定には使わない。
    try {
      const q = (navigator as unknown as {
        permissions?: { query: (d: { name: string }) => Promise<{ state: string }> };
      }).permissions;
      const st = await q?.query({ name: "local-network-access" });
      if (st) {
        const ok = out[0]?.verdict === "ok";
        out.push({
          label: "③ 参考：端末内への通信の許可設定",
          verdict: st.state === "granted" ? "ok" : "unknown",
          detail: `このブラウザは許可の管理対象です（現在の設定：${st.state}）。`
            + (ok
              ? "①が成功しているので、この表示は問題ありません。"
              : "①が失敗した原因がこれである可能性があります。無人運用では、許可を求める表示が出ない設定が必要です。"),
        });
      }
    } catch {
      // このブラウザは許可の仕組みを持っていない＝表示しない
    }

    setSent(urls);
    setLines(out);
    setReport([
      "■ 窓処サーバへの通知：接続確認の結果",
      `日時: ${new Date().toLocaleString("ja-JP")}`,
      `送信元のページ: ${window.location.href}`,
      `宛先: ${clean}`,
      "",
      ...out.map((l) => `${MARK[l.verdict]} ${l.label}\n   ${l.detail}`),
      "",
      "送ったURL:",
      ...urls.map((u) => `  ${u}`),
      "",
      `ブラウザ: ${window.navigator.userAgent}`,
      "",
      "※窓処サーバのログに、上記URL（machine=notify-test）が届いているかをご確認ください。",
      "※OPTIONS が記録されているかどうかも、あわせてお知らせください。",
    ].join("\n"));
    setRunning(false);
  }, [base]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900 p-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <h1 className="text-2xl font-bold">窓処サーバへの通知：接続確認</h1>
          <p className="mt-2 text-slate-700">
            通話が終わったとき、この画面（インターネット上のHTTPSのページ）から
            窓処端末の中で動いている窓処サーバへ通知が届くかを確かめます。
            <strong>窓処端末の実物でお試しください。</strong>
          </p>
        </header>

        <section className="rounded-lg border border-slate-300 bg-white p-5 space-y-3">
          <h2 className="font-bold text-lg">手順1：受け取る側が動いていることを確認する</h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-600" htmlFor="base">窓処サーバの宛先</label>
            <input
              id="base"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              className="flex-1 min-w-[16rem] rounded border border-slate-400 px-3 py-2 font-mono"
            />
          </div>
          <p className="text-sm text-slate-600">
            下のリンクで窓処サーバが応答すれば、サーバ自体は動いています。
            （ここはHTTPどうしなので、ブラウザの制限はかかりません）
          </p>
          <a
            href={base}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded bg-slate-700 px-4 py-2 text-white hover:bg-slate-800"
          >
            {base} を別のタブで開く
          </a>
        </section>

        <section className="rounded-lg border border-slate-300 bg-white p-5 space-y-4">
          <h2 className="font-bold text-lg">手順2：本番と同じ形で通知を送ってみる</h2>
          <button
            onClick={run}
            disabled={running}
            className="w-full rounded-lg bg-blue-700 px-6 py-5 text-xl font-bold text-white hover:bg-blue-800 disabled:bg-slate-400"
          >
            {running ? "送信中…" : "通知を送ってみる"}
          </button>

          {lines.length > 0 && (
            <div className="space-y-3">
              {lines.map((l, i) => (
                <div key={i} className={`rounded border-l-4 p-4 ${COLOR[l.verdict]}`}>
                  <div className="font-bold">{MARK[l.verdict]} {l.label}</div>
                  <div className="mt-1 text-sm">{l.detail}</div>
                </div>
              ))}
              <div className="rounded bg-slate-50 border border-slate-300 p-4 text-sm">
                <div className="font-bold mb-1">送ったURL（ログの照合にお使いください）</div>
                {sent.map((u) => (
                  <div key={u} className="font-mono break-all text-xs text-slate-700">{u}</div>
                ))}
              </div>
            </div>
          )}
        </section>

        {lines.length > 0 && (
          <section className="rounded-lg border-2 border-blue-600 bg-blue-50 p-5 space-y-3">
            <h2 className="font-bold text-lg">手順3：結果をお知らせください</h2>
            <p className="text-sm">
              <strong>この画面だけでは、届いたかどうかは分かりません。</strong>
              応答を読まない送り方のため、遮断されたのか、届いたのに応答が読めないだけなのかを
              区別できないためです。<strong>窓処サーバのログで、上のURL（<code>machine=notify-test</code>）が
              届いているかをご確認ください。</strong>
            </p>
            <ul className="list-disc pl-6 text-sm space-y-1">
              <li><strong>GET</strong> が届いたか（<code>via=fetch</code> と <code>via=img</code> のどちらが届いたか）</li>
              <li><strong>OPTIONS</strong> が記録されているか</li>
              <li>この画面に出た①②③の結果</li>
              <li>許可を求める表示が出たかどうか</li>
            </ul>
            <p className="text-sm">
              ①が失敗し、ログに <code>OPTIONS</code> が残っている場合は、窓処サーバが
              <code className="mx-1 rounded bg-white px-1">Access-Control-Allow-Private-Network: true</code>
              を返すようにすれば解決します。
            </p>
            <button
              onClick={copy}
              className="rounded bg-blue-700 px-5 py-3 font-bold text-white hover:bg-blue-800"
            >
              {copied ? "コピーしました" : "この結果をコピーする"}
            </button>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-xs text-slate-700 border border-slate-300">
              {report}
            </pre>
          </section>
        )}

        <footer className="text-xs text-slate-500">
          このページは接続確認専用です。通話の機能とは関係がなく、送信先は端末自身（localhost）に限られます。
        </footer>
      </div>
    </main>
  );
}
