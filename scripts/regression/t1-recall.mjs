/**
 * v1.48.0 退行テスト: 呼び直しで新しい通話の画面が消えない。
 *
 * お客様画面の動き（call:ended を受けたら3秒後に言語選択へ戻す・sessionId を照合する）を
 * そのまま写した模型で、最後にどの画面にいるかを見る。
 */
import { io } from "socket.io-client";
import { BASE, STATION, Checker, connectStaff, sleep } from "./_lib.mjs";

const c = new Checker("t1 呼び直し（v1.48.0）");

function makeKioskModel(log) {
  const s = io(BASE, { transports: ["websocket"] });
  const st = { phase: "lang-select", sessionId: null };
  const laterIfSameCall = (callId, ms, run) => setTimeout(() => {
    if (callId !== null && st.sessionId !== null && st.sessionId !== callId) return;
    run();
  }, ms);
  s.on("call:requested", (p) => { st.sessionId = p.sessionId; st.phase = "calling"; log.push(`requested ${p.sessionId}`); });
  s.on("call:answered", (p) => { st.sessionId = p.sessionId; st.phase = "in-call"; log.push(`answered ${p.sessionId}`); });
  s.on("call:ended", (p) => {
    const callId = st.sessionId;
    log.push(`ended ${p?.sessionId} (いまの通話=${callId})`);
    if (p?.sessionId && callId && p.sessionId !== callId) { log.push("  → 別の通話あてなので無視"); return; }
    st.phase = "ended";
    laterIfSameCall(callId, 3000, () => { st.phase = "lang-select"; st.sessionId = null; log.push("  → 言語選択へ戻した"); });
  });
  return { s, st };
}
const call = (k, id) => k.emit("call:request", { machineId: id, machineName: id, userLang: "ja", stationId: STATION });

// ① 同じソケットのまま呼び直す（当時の不具合そのもの）
{
  const log = []; const staff = await connectStaff({ uid: "reg-t1-a" });
  const { s: k, st } = makeKioskModel(log);
  await new Promise((r) => k.on("connect", r));
  call(k, "test-reg-recall-1"); await sleep(900);
  const s1 = st.sessionId;
  call(k, "test-reg-recall-1"); await sleep(4200);
  c.check("呼び直しても、お客様画面は通話中のまま", st.phase === "in-call", `画面=${st.phase}`);
  c.check("係員も新しい通話につながっている", staff.answered.at(-1) === st.sessionId && st.sessionId !== s1, `係員=${staff.answered.at(-1)} お客様=${st.sessionId}`);
  k.close(); staff.socket.close(); await sleep(300);
}
// ② ふつうの終了で言語選択へ戻る（退行していないか）
{
  const log = []; const staff = await connectStaff({ uid: "reg-t1-b" });
  const { s: k, st } = makeKioskModel(log);
  await new Promise((r) => k.on("connect", r));
  call(k, "test-reg-recall-2"); await sleep(900);
  k.emit("call:end", { sessionId: st.sessionId }); await sleep(3600);
  c.check("ふつうに終了すれば言語選択へ戻る", st.phase === "lang-select" && st.sessionId === null, `画面=${st.phase}`);
  k.close(); staff.socket.close(); await sleep(300);
}
// ③ 終了→次の通話で、古い通知が届かない（部屋がたまらない）
{
  const log = []; const staff = await connectStaff({ uid: "reg-t1-c" });
  const { s: k, st } = makeKioskModel(log);
  await new Promise((r) => k.on("connect", r));
  call(k, "test-reg-recall-3"); await sleep(900);
  const s1 = st.sessionId;
  k.emit("call:end", { sessionId: s1 }); await sleep(3600);
  call(k, "test-reg-recall-3"); await sleep(900);
  const s2 = st.sessionId;
  const stale = log.slice(log.findIndex((l) => l.startsWith(`requested ${s2}`))).some((l) => l.startsWith(`ended ${s1}`));
  c.check("2件目の通話中に、1件目あての終了通知が届かない", !stale, `1件目=${s1}`);
  c.check("2件目は通話中のまま", st.phase === "in-call" && staff.answered.at(-1) === s2, `画面=${st.phase}`);
  k.emit("call:end", { sessionId: s2 }); await sleep(500);
  k.close(); staff.socket.close(); await sleep(300);
}
process.exit(c.summary() ? 0 : 1);
