/**
 * 退行テストの共通部品。
 *
 * 前提: 開発サーバーが http://localhost:3001 で動いていること（`npm run dev`）。
 * ここにある疑似係員・疑似キオスクは **開発サーバー専用**。本番へは向けない
 * （疑似係員が一般のお客様の呼び出しを取ると、そのお客様は誰にもつながらない）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { SignJWT } from "jose";
import { WebSocket } from "ws";

export const BASE = process.env.REGRESSION_BASE ?? "http://localhost:3001";
if (/railway\.app|https:/.test(BASE)) {
  console.error("退行テストは開発サーバー専用です。本番へは向けません:", BASE);
  process.exit(2);
}
export const APP_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../..");
export const STATION = "test-station"; // 疑似係員の担当駅（テスト専用）
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadSecret() {
  const env = fs.readFileSync(path.join(APP_DIR, ".env.local"), "utf-8");
  const m = env.match(/^SESSION_SECRET=(.*)$/m);
  if (!m) throw new Error(".env.local に SESSION_SECRET が無い");
  return m[1].trim();
}

export async function staffCookie(uid, name) {
  const t = await new SignJWT({ uid, email: `${uid}@example.invalid`, name, isAdmin: false })
    .setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode(loadSecret()));
  return `staff-session=${t}`;
}

/** 合否を数える。最後に summary() で結果を出し、exit code を決める。 */
export class Checker {
  constructor(title) { this.title = title; this.results = []; console.log(`\n■ ${title}`); }
  check(name, ok, detail) {
    this.results.push(ok);
    console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
    return ok;
  }
  summary() {
    const ok = this.results.filter(Boolean).length;
    console.log(`→ ${this.title}: ${ok}/${this.results.length} 合格`);
    return this.results.every(Boolean);
  }
}

/**
 * 疑似係員。test- で始まる端末の着信にだけ応答する（安全装置）。
 * @returns {{ socket, seenUser: Array, onUser(fn) }}
 */
export async function connectStaff({ uid, name = "【退行テスト】係員", autoAnswer = true, answerDelayMs = 120 } = {}) {
  const socket = io(BASE, { transports: ["websocket"], extraHeaders: { cookie: await staffCookie(uid, name) } });
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("connect_error", rej); setTimeout(() => rej(new Error("疑似係員がつながらない")), 10000); });
  socket.emit("staff:join", { name, uid, stationIds: [STATION] });
  socket.emit("staff:setStatus", { status: "available" });
  const api = { socket, answered: [] };
  socket.on("call:incoming", (c) => {
    if (!String(c.machineId).startsWith("test-")) return; // 安全装置: テスト以外は取らない
    if (!autoAnswer) return;
    setTimeout(() => { socket.emit("call:answer", { sessionId: c.sessionId }); api.answered.push(c.sessionId); }, answerDelayMs);
  });
  await sleep(300);
  return api;
}

/** 疑似キオスク（端末）。machineId は必ず test- で始める。 */
export function connectKiosk() {
  const socket = io(BASE, { transports: ["websocket"] });
  const api = { socket, sessionId: null, events: [] };
  for (const ev of ["call:requested", "call:answered", "call:ended", "call:rejected", "call:timeout", "call:staffDisconnected", "call:noStaff", "speech:delivered", "speech:staff", "tts:audio", "tts:done"]) {
    socket.on(ev, (p) => api.events.push({ ev, p, at: Date.now() }));
  }
  socket.on("call:answered", (p) => { api.sessionId = p.sessionId; });
  api.ready = new Promise((r) => socket.on("connect", r));
  api.call = async (machineId, lang = "ja", waitMs = 1200) => {
    if (!machineId.startsWith("test-")) throw new Error("端末IDは test- で始めること");
    api.sessionId = null;
    socket.emit("call:request", { machineId, machineName: machineId, userLang: lang, stationId: STATION });
    await sleep(waitMs);
    return api.sessionId;
  };
  api.say = (text, { clientId, continuation, spokeAt, lang = "en" } = {}) =>
    socket.emit("speech:user", { sessionId: api.sessionId, text, lang, isFinal: true, clientId, continuation: continuation || undefined, spokeAt });
  api.end = () => socket.emit("call:end", { sessionId: api.sessionId });
  return api;
}

/** 開発サーバーがローカル保存した通話記録（logs/日付/セッション.json）。 */
export function readLog(sessionId) {
  const d = new Date();
  const dir = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const f = path.join(APP_DIR, "logs", dir, `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, "utf-8"));
}

// ── ヘッドレスChrome（CDP）──────────────────────────────────────────────────
export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export function hasChrome() { return fs.existsSync(CHROME); }

class Page {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.console = []; }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiters.set(id, (m) => (m.error ? reject(new Error(method + ": " + JSON.stringify(m.error))) : resolve(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page js: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  }
  async go(url, waitMs = 2500) { await this.send("Page.navigate", { url }); await sleep(waitMs); }
  async cookie(name, value) { await this.send("Network.setCookie", { name, value, domain: "localhost", path: "/" }); }
  /** 文字を含むボタンを押す（React の onClick が動く）。 */
  async clickText(text) {
    return this.js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(b){b.click();return true}return false})()`);
  }
  /** 本物のクリック（利用者の操作として扱われる＝音声の許可などに効く）。 */
  async realClickText(text) {
    const rect = await this.js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.includes(${JSON.stringify(text)}));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    if (!rect) return false;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }
    return true;
  }
  /** React の入力欄に値を入れる（value を直接書くだけでは React に伝わらない）。 */
  async setReactInput(selector, value) {
    return this.js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  }
  async screenshot(file) {
    await this.js(`document.querySelectorAll('nextjs-portal').forEach(e=>e.remove())`);
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }
}

/** ヘッドレスChromeを起動してタブを1つ返す。終わったら close() を呼ぶこと。 */
export async function launchChrome({ port = 9444, width = 1536, height = 864 } = {}) {
  const profile = fs.mkdtempSync(path.join("/private/tmp", "regression-chrome-"));
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--disable-gpu", "about:blank",
  ], { stdio: "ignore" });
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === "page"); } catch { /* まだ */ }
    if (!target) await sleep(250);
  }
  if (!target) { chrome.kill(); throw new Error("Chrome が起動しない"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((r) => ws.once("open", r));
  const page = new Page(ws);
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && page.waiters.has(m.id)) { page.waiters.get(m.id)(m); page.waiters.delete(m.id); return; }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      page.console.push({ type: m.params.type, text, at: Date.now() });
    }
  });
  await page.send("Page.enable"); await page.send("Network.enable"); await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  const close = () => { try { ws.close(); } catch { /* */ } try { chrome.kill(); } catch { /* */ } try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ } };
  return { page, close };
}

/** 係員画面を Cookie 付きで開く（同一オリジンに来てから Cookie を入れる＝実績のある手順）。 */
export async function openStaffPage(page, uid = "regression-staff-ui", name = "【退行テスト】係員") {
  const token = (await staffCookie(uid, name)).replace(/^staff-session=/, "");
  await page.go(`${BASE}/staff/login`, 2000);
  await page.cookie("staff-session", token);
  await page.go(`${BASE}/staff`, 4000);
}

/** 係員画面の会話エリアの吹き出しを文書順に読む。 */
export function readStaffBubbles(page) {
  return page.js(`(()=>{
    const out=[];
    for (const el of document.querySelectorAll('.rounded-2xl')) {
      if (el.classList.contains('bg-blue-500')) out.push({who:'user', text:el.textContent});
      else if (el.classList.contains('bg-gray-100') && !el.classList.contains('italic')) out.push({who:'staff', text:el.textContent});
    }
    const marks=[...document.querySelectorAll('span')].filter(s=>s.textContent.includes('確定する前の返答')).length;
    const tr=[...document.querySelectorAll('.bg-blue-50.rounded-xl')].map(e=>e.textContent);
    return {bubbles:out, earlyMarks:marks, translations:tr};
  })()`);
}
