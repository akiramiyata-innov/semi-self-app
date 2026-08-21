/**
 * v1.52.0 退行テスト: 発言は「話し始めの時刻（spokeAt）」の順に並び、
 * お客様の発言が係員の返答より上に差し込まれたときは、その返答に「確定前の返答」の印が付く。
 */
import { Checker, connectStaff, connectKiosk, readLog, sleep } from "./_lib.mjs";

const c = new Checker("t6 話し始めの順と確定前の返答の印（v1.52.0）");
const staff = await connectStaff({ uid: "reg-t6" });
const toStaff = [];
staff.socket.on("speech:user", (p) => { if (p.isFinal) toStaff.push(p); });
const kiosk = connectKiosk(); await kiosk.ready;
const toKiosk = [];
kiosk.socket.on("speech:staff", (p) => { if (p.isFinal) toKiosk.push(p); });

const sid = await kiosk.call("test-reg-ordering", "en");
c.check("通話が成立", !!sid, sid);

// ① 係員の素早い短い返事が、お客様の発言より先に確定した場面
//    （お客様は3秒前に話し始めていたが確定が遅れた・係員は0.5秒前に話し始めてすぐ確定）
const t0 = Date.now();
staff.socket.emit("speech:staff", { sessionId: sid, text: "はい", isFinal: true, spokeAt: t0 - 500 });
await sleep(300);
kiosk.say(" where is the elevator", { clientId: "u1", spokeAt: t0 - 3000 });
await sleep(4000);
c.check("係員へ届くお客様の発言に spokeAt が付いている", toStaff[0]?.spokeAt === t0 - 3000, `spokeAt=${toStaff[0]?.spokeAt}`);
c.check("お客様へ届く係員の発言に spokeAt が付いている", toKiosk[0]?.spokeAt === t0 - 500, `spokeAt=${toKiosk[0]?.spokeAt}`);

// ② ふつうの順（お客様が先に確定、係員が後から返す）
const t1 = Date.now();
kiosk.say(" thank you", { clientId: "u2", spokeAt: t1 - 2000 });
await sleep(2500);
staff.socket.emit("speech:staff", { sessionId: sid, text: "どういたしまして", isFinal: true, spokeAt: Date.now() - 300 });
await sleep(3000);

// ③ 端末が変な時刻を送ってきた（未来）→ 届いた時刻で代用
const t2 = Date.now();
kiosk.say(" bogus time", { clientId: "u3", spokeAt: t2 + 999_999 });
await sleep(2500);
c.check("未来の spokeAt は捨てられ、届いた時刻になる", Math.abs((toStaff.at(-1)?.spokeAt ?? 0) - t2) < 2000, `spokeAt=${toStaff.at(-1)?.spokeAt} 期待≈${t2}`);

// ④ 係員のテキスト送信（spokeAt 無し）→ 届いた時刻
const t3 = Date.now();
staff.socket.emit("speech:staff", { sessionId: sid, text: "テキストです", isFinal: true });
await sleep(3000);
const tk = toKiosk.at(-1);
c.check("テキスト送信は届いた時刻が spokeAt になる", Math.abs((tk?.spokeAt ?? 0) - t3) < 2500, `spokeAt=${tk?.spokeAt} 期待≈${t3}`);

// ⑤ 分割確定を繋いでも、話し始めは前半のまま
const t4 = Date.now();
kiosk.say(" can i get there faster by switching to", { clientId: "u5", spokeAt: t4 - 1500 });
await sleep(3);
kiosk.say(" an express train", { clientId: "u5", continuation: true, spokeAt: t4 - 100 });
await sleep(4500);
const merged = toStaff.find((p) => p.replacesPrev);
c.check("繋いだ発言の spokeAt は前半の値のまま", merged?.spokeAt === t4 - 1500, `spokeAt=${merged?.spokeAt}`);

kiosk.end(); await sleep(2500);
const log = readLog(sid);
const order = log?.transcript.map((m) => `${m.speaker}:${m.text.trim().slice(0, 10)}${m.earlyReply ? "★" : ""}`) ?? [];
console.log("   記録の並び:", JSON.stringify(order));
c.check("①の記録: お客様の発言が係員の「はい」より上に並ぶ", order[0]?.startsWith("user:where") && order[1]?.startsWith("staff:はい"), "");
const hai = log?.transcript.find((m) => m.text === "はい");
c.check("①の「はい」に確定前の返答の印（earlyReply）が付く", hai?.earlyReply === true, `earlyReply=${hai?.earlyReply}`);
const dou = log?.transcript.find((m) => m.text === "どういたしまして");
c.check("②のふつうの返答には印が付かない", dou && !dou.earlyReply, `earlyReply=${dou?.earlyReply}`);
c.check("記録全体が spokeAt の昇順", log?.transcript.every((m, i, a) => i === 0 || (a[i - 1].spokeAt ?? a[i - 1].timestamp) <= (m.spokeAt ?? m.timestamp)), "");

kiosk.socket.close(); staff.socket.close();
process.exit(c.summary() ? 0 : 1);
