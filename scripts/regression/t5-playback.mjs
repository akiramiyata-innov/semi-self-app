/**
 * v1.50.0 退行テスト（本物のお客様画面・ヘッドレスChrome）:
 *   ① 係員の返答が3つに分かれて届いても、全部鳴ってマイクが1回で戻る（一時停止→再開が1組）
 *   ② 音声の変換が終わらない端末でも、15秒の見張りで自動復帰し係員へ知らせる
 * 偽マイクは Chrome の --use-fake-device-for-media-stream（無音に近い）で用意される。
 */
import { BASE, Checker, connectStaff, hasChrome, launchChrome, sleep } from "./_lib.mjs";

const c = new Checker("t5 読み上げ不発とマイク復帰（v1.50.0）");
if (!hasChrome()) { console.log("Google Chrome が無いため飛ばします"); process.exit(0); }

const staff = await connectStaff({ uid: "reg-t5", autoAnswer: true });
const staffErrors = [];
staff.socket.on("error:tts", (p) => staffErrors.push(p));
const { page, close } = await launchChrome({ port: 9445 });
try {
  await page.go(`${BASE}/user?machine=test-reg-playback&name=test-reg-playback`, 3000);
  c.check("言語選択が出た", await page.realClickText("English"), "");
  await sleep(1200);
  c.check("係員を呼んだ", await page.realClickText("Call Staff"), "");
  // 係員が応答するのを待つ
  let sid = null;
  for (let i = 0; i < 40 && !sid; i++) { await sleep(250); sid = staff.answered.at(-1) ?? null; }
  c.check("通話が成立", !!sid, sid);
  await sleep(2500);

  const micLogs = () => page.console.filter((l) => l.text.startsWith("[mic]")).map((l) => l.text);

  // ① 3分割の返答（S5の形）
  staff.socket.emit("speech:staff", { sessionId: sid, text: "今いらっしゃる南北線のホームから", isFinal: true });
  await sleep(100);
  staff.socket.emit("speech:staff", { sessionId: sid, text: "地下1階まで上がってください。地上", isFinal: true });
  await sleep(4000);
  staff.socket.emit("speech:staff", { sessionId: sid, text: "への案内に沿って進んでいただきますと2番出口に出られます", isFinal: true });
  // 全部鳴り終わるまで待つ（3つで最長20秒程度）
  let logs = [];
  for (let i = 0; i < 60; i++) { await sleep(500); logs = micLogs(); if (logs.length >= 2 && logs.at(-1).includes("再開")) break; }
  const pauses = logs.filter((l) => l.includes("一時停止")).length, resumes = logs.filter((l) => l.includes("再開")).length;
  c.check("3分割でも一時停止→再開が1組だけ（途中で戻らず、最後に戻る）", pauses === 1 && resumes === 1, JSON.stringify(logs));
  c.check("再生失敗の見張りは発動していない", !page.console.some((l) => l.text.includes("時間切れ")), "");

  // ② 音声の変換を永遠に終わらせない → 15秒で自動復帰
  await page.js(`(()=>{const p=(window.AudioContext||window.webkitAudioContext).prototype;p.decodeAudioData=function(){return new Promise(()=>{})};return true})()`);
  const before = page.console.length;
  staff.socket.emit("speech:staff", { sessionId: sid, text: "これは見張りの試験です。この音声は鳴らないはずです", isFinal: true });
  let fired = false;
  for (let i = 0; i < 50 && !fired; i++) { await sleep(500); fired = page.console.slice(before).some((l) => l.text.includes("読み上げが始まらないまま時間切れ")); }
  c.check("15秒の見張りが発動した", fired, "");
  await sleep(1500); // 見張り → 残響の余韻（0.5秒）→ マイク再開 の順なので、少し待ってから読む
  const after = page.console.slice(before).filter((l) => l.text.startsWith("[mic]")).map((l) => l.text);
  c.check("見張りのあとマイクが再開した", after.includes("[mic] 再開"), JSON.stringify(after));
  c.check("係員へ「お客様の端末で再生できない」が届いた", staffErrors.some((e) => e.reason === "playback"), JSON.stringify(staffErrors));

  staff.socket.emit("call:end", { sessionId: sid });
  await sleep(800);
} finally {
  close(); staff.socket.close();
}
process.exit(c.summary() ? 0 : 1);
