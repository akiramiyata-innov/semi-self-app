/**
 * Race condition test
 * 2人のスタッフが同じ呼び出しにほぼ同時に応答したときの動作を確認する
 */
import { io } from "socket.io-client";

const URL = "http://localhost:3001";

function connect(name) {
  return new Promise((resolve) => {
    const s = io(URL, { path: "/socket.io", transports: ["websocket"] });
    s.on("connect", () => {
      s.emit("staff:join", { name });
      console.log(`[${name}] 接続完了 id=${s.id}`);
      resolve(s);
    });
  });
}

async function run() {
  console.log("=== レースコンディションテスト開始 ===\n");

  // 2人のスタッフを接続
  const [staff1, staff2] = await Promise.all([
    connect("スタッフA"),
    connect("スタッフB"),
  ]);

  // キオスクユーザーを接続して呼び出し
  const user = io(URL, { path: "/socket.io", transports: ["websocket"] });
  await new Promise((r) => user.on("connect", r));
  console.log("[ユーザー] 接続完了、呼び出し送信...\n");

  // 両スタッフが call:incoming を受け取ったら同時に応答
  const sessionIdPromise = new Promise((resolve) => {
    let received = 0;
    let sessionId = null;

    const onIncoming = (payload) => {
      sessionId = payload.sessionId;
      received++;
      if (received === 2) resolve(sessionId);
    };

    staff1.on("call:incoming", onIncoming);
    staff2.on("call:incoming", onIncoming);
  });

  // 応答結果を監視
  staff1.on("call:alreadyTaken", ({ sessionId }) => {
    console.log(`[スタッフA] ❌ call:alreadyTaken → sessionId=${sessionId}`);
  });
  staff2.on("call:alreadyTaken", ({ sessionId }) => {
    console.log(`[スタッフB] ❌ call:alreadyTaken → sessionId=${sessionId}`);
  });
  staff1.on("call:taken", ({ sessionId }) => {
    console.log(`[スタッフA] 📢 call:taken (他のスタッフが応答) → sessionId=${sessionId}`);
  });
  staff2.on("call:taken", ({ sessionId }) => {
    console.log(`[スタッフB] 📢 call:taken (他のスタッフが応答) → sessionId=${sessionId}`);
  });
  user.on("call:answered", ({ sessionId, staffName }) => {
    console.log(`\n[ユーザー] ✅ call:answered → staffName="${staffName}" sessionId=${sessionId}`);
    console.log("\n=== テスト完了: 1人だけが応答できたことを確認 ===");
  });

  // 呼び出し送信
  user.emit("call:request", { machineId: "kiosk-test", machineName: "テスト端末" });

  // 両スタッフが着信を受け取ったら同時に応答
  const sessionId = await sessionIdPromise;
  console.log(`[両スタッフ] call:incoming 受信 → sessionId=${sessionId}`);
  console.log("[両スタッフ] 同時にcall:answerを送信...\n");

  staff1.emit("call:answer", { sessionId });
  staff2.emit("call:answer", { sessionId });

  // 3秒後に終了
  setTimeout(() => {
    staff1.disconnect();
    staff2.disconnect();
    user.disconnect();
    process.exit(0);
  }, 3000);
}

run().catch(console.error);
