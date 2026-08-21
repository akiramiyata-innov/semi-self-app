/**
 * v1.51.0 退行テスト: 分割確定を直前の発言に繋いで1つの文として訳し直す（サーバー側）。
 * キオスク画面が送るのと同じ形（continuation=true・clientId=直前の発言のid）で送る。
 */
import { Checker, connectStaff, connectKiosk, readLog, sleep } from "./_lib.mjs";

const c = new Checker("t3 分割確定の繋ぎ直し（v1.51.0）");
const staff = await connectStaff({ uid: "reg-t3" });
const seen = [];
staff.socket.on("speech:user", (p) => { if (p.isFinal) seen.push({ text: p.text, tr: p.translatedText, rep: !!p.replacesPrev }); });
const kiosk = connectKiosk(); await kiosk.ready;
const delivered = [];
kiosk.socket.on("speech:delivered", (p) => delivered.push(p.clientId));

// 通話1: S3の形 ＋ 係員の発言を挟んだ3分割
{
  const sid = await kiosk.call("test-reg-merge-1", "en");
  c.check("通話1 成立", !!sid, sid);
  kiosk.say(" is it possible to top up by just", { clientId: "c1" });
  await sleep(3);
  kiosk.say(" 1,000 yen", { clientId: "c1", continuation: true });
  await sleep(4500);
  c.check("係員へ 1件目→差し替え の順で届く", seen.length === 2 && !seen[0].rep && seen[1].rep, JSON.stringify(seen.map((s) => [s.rep, s.text])));
  c.check("差し替えの全文が繋がっている", seen[1]?.text === " is it possible to top up by just 1,000 yen", seen[1]?.text);
  c.check("訳が全文の意味（1,000円 と チャージ を含む）", /1,?000/.test(seen[1]?.tr ?? "") && /チャージ/.test(seen[1]?.tr ?? ""), `訳=${seen[1]?.tr}`);
  c.check("既読の宛先は直前の発言のid（c1 が2回）", delivered.filter((d) => d === "c1").length === 2, JSON.stringify(delivered));

  seen.length = 0;
  staff.socket.emit("speech:staff", { sessionId: sid, text: "はい", isFinal: true });
  await sleep(2500);
  kiosk.say(" it is close to the bench that you see right after entering", { clientId: "c2" });
  await sleep(3);
  kiosk.say(" through the ticket gate", { clientId: "c2", continuation: true });
  await sleep(3);
  kiosk.say(" on your left", { clientId: "c2", continuation: true });
  await sleep(5000);
  const finals = seen.filter((s) => /bench|left/.test(s.text));
  c.check("3分割が 1件目→差し替え→差し替え で届く", finals.length === 3 && !finals[0].rep && finals[1].rep && finals[2].rep, JSON.stringify(finals.map((s) => [s.rep, s.text.slice(-20)])));
  c.check("最終の全文が3つ繋がっている", finals[2]?.text === " it is close to the bench that you see right after entering through the ticket gate on your left", finals[2]?.text);

  kiosk.end(); await sleep(2500);
  const log = readLog(sid);
  const users = log?.transcript.filter((m) => m.speaker === "user") ?? [];
  const order = log?.transcript.map((m) => `${m.speaker}:${m.text.slice(0, 14).trim()}`) ?? [];
  c.check("通話記録のお客様発言は2件（分割は1件に繋がっている）", users.length === 2, JSON.stringify(order));
  c.check("記録1件目の全文と訳し直した訳", users[0]?.text === " is it possible to top up by just 1,000 yen" && /チャージ/.test(users[0]?.translatedText ?? ""), `${users[0]?.text} / ${users[0]?.translatedText}`);
  c.check("記録の順番は お客様→係員→お客様", order[0]?.startsWith("user") && order[1]?.startsWith("staff") && order[2]?.startsWith("user"), JSON.stringify(order));
}
// 通話2: 繋ぐ相手が無い／古いときは繋がない
{
  seen.length = 0;
  const sid = await kiosk.call("test-reg-merge-2", "en");
  c.check("通話2 成立", !!sid, sid);
  kiosk.say(" hello there", { clientId: "d1", continuation: true });
  await sleep(3000);
  c.check("相手が無い continuation は新しい発言として届く", seen.length === 1 && !seen[0].rep && seen[0].text === " hello there", JSON.stringify(seen));
  console.log("   （16秒待って、古い発言には繋がないことを確かめる）");
  await sleep(16000);
  kiosk.say(" how are you", { clientId: "d2", continuation: true });
  await sleep(3000);
  c.check("15秒を超えた continuation は繋がない", seen.length === 2 && !seen[1].rep && seen[1].text === " how are you", JSON.stringify(seen.map((s) => [s.rep, s.text])));
  kiosk.end(); await sleep(1500);
}
kiosk.socket.close(); staff.socket.close();
process.exit(c.summary() ? 0 : 1);
