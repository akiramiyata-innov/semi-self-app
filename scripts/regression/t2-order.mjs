/**
 * v1.49.0 退行テスト: 分割確定の後半が前半を追い越さない（同じ話し手の確定は届いた順）。
 * 実際の翻訳API（待ち時間が文の長さで変わる＝追い越しの原因そのもの）を使う。
 */
import { Checker, connectStaff, connectKiosk, readLog, sleep } from "./_lib.mjs";

const c = new Checker("t2 分割確定の追い越し（v1.49.0）");
const staff = await connectStaff({ uid: "reg-t2" });
const seen = [];
staff.socket.on("speech:user", (p) => { if (p.isFinal) seen.push(p.text); });
const kiosk = connectKiosk(); await kiosk.ready;
const staffTexts = [];
kiosk.socket.on("speech:staff", (p) => { if (p.isFinal) staffTexts.push(p.text); });

const sid = await kiosk.call("test-reg-order", "en");
c.check("通話が成立", !!sid, sid);

// お客様: 長い前半 → 3ms後に短い後半（S3の形）
kiosk.say(" is it possible to top up by just", { clientId: "a1" });
await sleep(3);
kiosk.say(" 1,000 yen", { clientId: "a2" });
await sleep(4000);
c.check("お客様: 前半→後半の順で届く", seen[0] === " is it possible to top up by just" && seen[1] === " 1,000 yen", JSON.stringify(seen));

// 係員: 長い前半 → 3ms後に短い後半
staff.socket.emit("speech:staff", { sessionId: sid, text: "今いらっしゃる南北線のホームから地下1階まで上がってください", isFinal: true });
await sleep(3);
staff.socket.emit("speech:staff", { sessionId: sid, text: "地上です", isFinal: true });
await sleep(9000);
c.check("係員: 前半→後半の順でお客様へ届く", staffTexts.length === 2 && /Namboku/i.test(staffTexts[0]) && staffTexts[1].length < staffTexts[0].length, JSON.stringify(staffTexts));
c.check("音声も両方届く", kiosk.events.filter((e) => e.ev === "tts:audio").length >= 2, `音声${kiosk.events.filter((e) => e.ev === "tts:audio").length}件`);

kiosk.end(); await sleep(2500);
const log = readLog(sid);
const users = log?.transcript.filter((m) => m.speaker === "user").map((m) => m.text) ?? [];
c.check("通話記録も前半→後半の順", users[0]?.includes("possible") && users[1]?.includes("1,000"), JSON.stringify(log?.transcript.map((m) => `${m.speaker}:${m.text.slice(0, 12).trim()}`)));

kiosk.socket.close(); staff.socket.close();
process.exit(c.summary() ? 0 : 1);
