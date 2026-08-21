/**
 * 退行テスト（本物の係員画面・ヘッドレスChrome）:
 *   v1.51.0 分割確定を繋いだ結果が吹き出し1つに差し替わる
 *   v1.52.0 お客様の発言が係員の返答より上に差し込まれ、返答に「確定前の返答」の印が付く
 */
import path from "node:path";
import { APP_DIR, Checker, connectKiosk, hasChrome, launchChrome, openStaffPage, readStaffBubbles, sleep } from "./_lib.mjs";

const c = new Checker("t4 係員画面（v1.51.0 繋ぎ直し・v1.52.0 並びと印）");
if (!hasChrome()) { console.log("Google Chrome が無いため飛ばします"); process.exit(0); }

const { page, close } = await launchChrome({ port: 9444 });
try {
  await openStaffPage(page, "reg-t4-ui");
  c.check("係員画面が開いた", await page.js("document.body.innerText.includes('通話待機中') || document.body.innerText.includes('対応可')"), "");

  const kiosk = connectKiosk(); await kiosk.ready;
  kiosk.socket.emit("call:request", { machineId: "test-reg-ui", machineName: "test-reg-ui", userLang: "en", stationId: "" });
  await sleep(2000);
  c.check("着信に応答した", await page.clickText("応答"), "");
  await sleep(2500);
  c.check("通話が成立", !!kiosk.sessionId, kiosk.sessionId);

  // ── v1.51.0: 繋ぎ直し
  kiosk.say(" is it possible to top up by just", { clientId: "c1" });
  await sleep(2500);
  let r = await readStaffBubbles(page);
  c.check("前半が1つの吹き出しで出た", r.bubbles.filter((b) => b.who === "user").length === 1, JSON.stringify(r.bubbles));
  kiosk.say(" 1,000 yen", { clientId: "c1", continuation: true });
  await sleep(4000);
  r = await readStaffBubbles(page);
  const users = r.bubbles.filter((b) => b.who === "user");
  c.check("後半が届いても吹き出しは1つのまま（差し替え）", users.length === 1, JSON.stringify(users));
  c.check("吹き出しの中身が全文", (users[0]?.text ?? "").trim() === "is it possible to top up by just 1,000 yen", users[0]?.text);
  c.check("訳も全文の意味（チャージ を含む）", r.translations.some((x) => /チャージ/.test(x) && /1,?000/.test(x)), JSON.stringify(r.translations));

  // ── v1.52.0: 係員がテキストで素早く返す → そのあとに、先に話し始めていたお客様の発言が確定
  c.check("入力欄に文字を入れた", await page.setReactInput('input[placeholder*="テキストで送信"]', "はい"), "");
  c.check("送信を押した", await page.clickText("送信"), "");
  await sleep(2500);
  r = await readStaffBubbles(page);
  c.check("係員の返答「はい」が末尾に出た", r.bubbles.at(-1)?.who === "staff" && r.bubbles.at(-1)?.text.includes("はい"), JSON.stringify(r.bubbles.map((b) => b.who + ":" + b.text.trim().slice(0, 10))));
  c.check("この時点で印は無い", r.earlyMarks === 0, `印=${r.earlyMarks}`);

  kiosk.say(" where is the elevator", { clientId: "u9", spokeAt: Date.now() - 6000 }); // 6秒前に話し始めていた
  await sleep(3500);
  r = await readStaffBubbles(page);
  const seq = r.bubbles.map((b) => b.who + ":" + b.text.trim().slice(0, 12));
  const idxElev = r.bubbles.findIndex((b) => b.text.includes("elevator"));
  const idxHai = r.bubbles.findIndex((b) => b.who === "staff" && b.text.includes("はい"));
  c.check("お客様の発言が係員の「はい」より上に差し込まれた", idxElev >= 0 && idxHai > idxElev, JSON.stringify(seq));
  c.check("「はい」に「お客様の発言が確定する前の返答」の印が出た", r.earlyMarks === 1, `印=${r.earlyMarks}`);

  const shot = path.join(APP_DIR, "scripts/regression/out", "t4-staffui.png");
  try { (await import("node:fs")).mkdirSync(path.dirname(shot), { recursive: true }); await page.screenshot(shot); console.log("   画面を保存:", shot); } catch { /* 画面保存は任意 */ }

  kiosk.end(); await sleep(800);
  kiosk.socket.close();
} finally {
  close();
}
process.exit(c.summary() ? 0 : 1);
