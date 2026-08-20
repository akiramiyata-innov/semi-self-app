/**
 * 疑似係員。着信を受けて即座に応答し、台本どおりに日本語で返事をする。
 *
 * 【安全装置】三重にかけてある。ひとつでも外すと一般のお客様に迷惑がかかる。
 *   ① 担当駅をテスト専用駅だけにする（起動時に stationIds で宣言する）
 *   ② 端末名・端末IDが "test-" で始まらない着信には**絶対に応答しない**（config.isTestCall）
 *   ③ 応答は着信を受けて即座に行う（人が取る前に片づけ、他の係員の画面を占領しない）
 *
 * 【終わったら必ず止めること】
 *   生き残っていると、本番の待機一覧に残り続ける。Ctrl+C か、run.mjs が自動で止める。
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { io } from "socket.io-client";
import { SignJWT } from "jose";
import {
  AGENT_STAFF_EMAIL, AGENT_STAFF_NAME, AGENT_STAFF_UID, AUDIO,
  isTestCall, log, roomTone, targetUrl,
} from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function makeStaffCookie(secret) {
  const token = await new SignJWT({
    uid: AGENT_STAFF_UID, email: AGENT_STAFF_EMAIL, name: AGENT_STAFF_NAME, isAdmin: false,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("6h")
    .sign(new TextEncoder().encode(secret));
  return `staff-session=${token}`;
}

/**
 * 疑似係員を起動する。
 * @param {object} opts
 * @param {string} opts.secret       SESSION_SECRET
 * @param {string[]} opts.stationIds 担当駅（テスト専用駅のIDだけを渡すこと）
 * @param {(ev: object) => void} opts.onEvent 起きたことの記録先
 */
export async function startFakeStaff({ secret, stationIds, onEvent = () => {}, ignoreCalls = false }) {
  if (!Array.isArray(stationIds) || stationIds.length === 0) {
    throw new Error("担当駅（stationIds）が空です。空にすると全駅の着信を受けてしまうため、必ずテスト専用駅を指定してください。");
  }
  const cookie = await makeStaffCookie(secret);
  const socket = io(targetUrl(), {
    transports: ["websocket"],
    extraHeaders: { cookie },
    auth: { cookie },
  });

  /** 応答した通話。sessionId → { machineName, lang, replies, turn, resolve } */
  const calls = new Map();
  let refused = 0;

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("疑似係員がつながりません")), 15000);
  });

  // ★通信が切れて自動でつなぎ直すと**ソケットの番号が変わる**。サーバーは通話ごとに
  //   担当係員のソケット番号を覚えているため、つなぎ直しただけでは発言が届かなくなる。
  //   起きたことを必ず記録し、つなぎ直したら参加もやり直す。
  socket.on("disconnect", (reason) => {
    log("疑似係員", `⚠ 接続が切れました（${reason}）`);
    onEvent({ type: "staffDisconnected", reason, at: Date.now() });
  });
  socket.io.on("reconnect", () => {
    log("疑似係員", "⚠ つなぎ直しました。参加をやり直します");
    onEvent({ type: "staffReconnected", at: Date.now() });
    socket.emit("staff:join", { name: AGENT_STAFF_NAME, uid: AGENT_STAFF_UID, stationIds });
    socket.emit("staff:setStatus", { status: "available" });
  });

  socket.emit("staff:join", { name: AGENT_STAFF_NAME, uid: AGENT_STAFF_UID, stationIds });
  socket.emit("staff:setStatus", { status: "available" });
  log("疑似係員", `接続しました（担当駅 ${stationIds.length} 件・${targetUrl()}）`);

  socket.on("call:incoming", (call) => {
    // ★安全装置②：テストの呼び出し以外には手を出さない
    if (!isTestCall(call)) {
      refused++;
      log("疑似係員", `⚠ テスト以外の着信を無視しました（${call?.machineName ?? "?"}）。一般のお客様の呼び出しです。`);
      onEvent({ type: "refusedForeignCall", machineName: call?.machineName, at: Date.now() });
      return;
    }
    // 異常系試験：わざと応答しない（未応答タイムアウトを起こすため）
    if (ignoreCalls) {
      socket.emit("call:incomingShown", { sessionId: call.sessionId });
      onEvent({ type: "sawButIgnored", sessionId: call.sessionId, machineName: call.machineName, at: Date.now() });
      log("疑似係員", `着信を確認しましたが、わざと応答しません: ${call.machineName}`);
      return;
    }
    // 「着信カードが画面に出た」合図。性能測定（呼び出し→着信）はこれで止まるので、
    // 本番の係員画面と同じように必ず送る。送らないと測定値が出ない。
    socket.emit("call:incomingShown", { sessionId: call.sessionId });
    // ★安全装置③：即座に応答（人が取る前に）
    socket.emit("call:answer", { sessionId: call.sessionId });
    calls.set(call.sessionId, { turn: 0, done: 0, machineName: call.machineName });
    onEvent({ type: "answered", sessionId: call.sessionId, machineName: call.machineName, at: Date.now() });
    log("疑似係員", `応答しました: ${call.machineName} (${call.sessionId})`);
  });

  socket.on("call:alreadyTaken", (p) => {
    log("疑似係員", `⚠ 先に他の係員が応答しました（${p.sessionId}）。この通話は測定できません。`);
    onEvent({ type: "lostRace", sessionId: p.sessionId, at: Date.now() });
    calls.delete(p.sessionId);
  });

  /**
   * 係員側の音声認識の確定を受け取る。
   * ★係員のソケットにもサーバー側の音声認識が付いている（socketServer.ts:817 で全ソケットに登録）。
   *   そのため本物の係員画面とまったく同じ経路で「話す→文字になる」を通せる。
   */
  /**
   * ★本物の係員画面は「確定するたびに、その1件をそのまま送信」する
   *   （app/staff/page.tsx の onFinal）。長い発話は音声認識が途中で何度も確定を返すため、
   *   結果として複数のメッセージに分かれてお客様へ届く。ここも同じ動きにする。
   */
  let speaking = null;   // 発話中の通話 { sessionId, seq, sent }
  socket.on("stt:final", (p) => {
    onEvent({ type: "staffSttFinal", text: p.transcript, at: Date.now() });  // T2の終点
    if (!p.transcript || !speaking) return;
    speaking.sent++;
    socket.emit("speech:staff", {
      sessionId: speaking.sessionId, text: p.transcript, isFinal: true,
      clientId: `auto-${speaking.seq}-${speaking.sent}`,
    });
    onEvent({ type: "staffSend", sessionId: speaking.sessionId, text: p.transcript,
              part: speaking.sent, at: Date.now() });                        // T3の終点
    log("疑似係員", `返事(${speaking.seq}-${speaking.sent}): ${p.transcript.slice(0, 30)}`);
  });
  socket.on("stt:error", (p) => onEvent({ type: "staffSttError", message: p.message, at: Date.now() }));

  /** 係員が声で話す。台本の音声を流し、確定が出るたびにその場で送る。 */
  async function speakReply(sessionId, pcmPath, fallbackText, seq) {
    onEvent({ type: "staffReplyStart", sessionId, seq, at: Date.now() });
    log("疑似係員", `返事(${seq})を話し始めます`);
    socket.emit("staff:composing", { sessionId, active: true });
    const pcm = await readFile(pcmPath);
    speaking = { sessionId, seq, sent: 0 };
    socket.emit("stt:start", { lang: "ja-JP" });
    const t1 = Date.now();
    onEvent({ type: "staffSpeakStart", sessionId, at: t1 });          // T1の起点
    const size = AUDIO.chunkBytes;
    for (let i = 0, n = 0; i < pcm.length; i += size, n++) {
      socket.emit("stt:audio", pcm.subarray(i, Math.min(i + size, pcm.length)));
      const wait = t1 + (n + 1) * AUDIO.chunkMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const audioSec = pcm.length / (AUDIO.sampleRate * AUDIO.bytesPerSample);
    const realSec = (Date.now() - t1) / 1000;
    onEvent({ type: "staffSpeakEnd", sessionId, audioSec: Math.round(audioSec * 10) / 10,
              realSec: Math.round(realSec * 10) / 10, at: Date.now() });  // T1の終点＝T2の起点
    if (realSec > audioSec * 1.2) {
      log("疑似係員", `⚠ 送り出しが実時間に追いつけませんでした（${realSec.toFixed(1)}秒／音声${audioSec.toFixed(1)}秒）`);
    }
    // ★話し終えた後もマイクは開いたまま、環境音を流し続ける。
    //   認識AIはこの無音区間を見て「話し終わった」と判断し、最後の確定を返す。
    const before = speaking.sent;
    const tone = roomTone(pcm, 8000);
    for (let i = 0; i < tone.length; i += size) {
      socket.emit("stt:audio", tone.subarray(i, Math.min(i + size, tone.length)));
      await sleep(AUDIO.chunkMs);
      if (speaking.sent > before) break;   // 最後の確定が出たら終わり
    }
    await sleep(300);
    socket.emit("stt:stop");
    const sent = speaking.sent;
    speaking = null;
    const rec = calls.get(sessionId);
    if (rec) rec.done = seq;   // この往復の返事は終わり（進行役がこれを待つ）
    if (sent === 0) {
      // 一度も確定しなかったときだけ、台本の文をそのまま送る（測定が途切れないように）
      log("疑似係員", `⚠ 係員側の認識が確定しませんでした。台本の文をそのまま送ります`);
      socket.emit("speech:staff", { sessionId, text: fallbackText, isFinal: true, clientId: `auto-${seq}-fallback` });
      onEvent({ type: "staffSend", sessionId, text: fallbackText, part: 1, fallback: true, at: Date.now() });
    }
  }

  // お客様の発言（確定）を受けたら、台本の次の返事を返す
  socket.on("speech:user", (p) => {
    if (!p.isFinal) return;
    onEvent({
      type: "userFinal", sessionId: p.sessionId, text: p.text,
      translatedText: p.translatedText, lang: p.lang, at: Date.now(),   // T11の終点
    });
    const c = calls.get(p.sessionId);
    if (!c || !c.replies) { log("疑似係員", "⚠ 発言が届いたが、この通話の台本がありません"); return; }
    const reply = c.replies[c.turn];
    if (reply === undefined) return;
    if (speaking) {   // まだ前の返事を話している途中（本物の係員も割り込んで話し始めない）
      log("疑似係員", "前の返事を話している最中のため、この確定には返事しません");
      return;
    }
    const seq = ++c.turn;
    const pcm = c.audio?.[seq - 1];
    setTimeout(() => {
      if (pcm && existsSync(pcm)) {
        speakReply(p.sessionId, pcm, reply, seq).catch((e) =>
          log("疑似係員", `⚠ 返事の送出に失敗: ${e.message}`));
      } else {
        // 音声が無いときは従来どおり文字で送る（互換のため残す）
        socket.emit("staff:composing", { sessionId: p.sessionId, active: true });
        socket.emit("speech:staff", { sessionId: p.sessionId, text: reply, isFinal: true, clientId: `auto-${seq}` });
        onEvent({ type: "staffSend", sessionId: p.sessionId, text: reply, scripted: reply, recognized: null, at: Date.now() });
        log("疑似係員", `返事(${seq}・文字): ${reply.slice(0, 30)}`);
      }
    }, Number(process.env.STAFF_THINK_MS ?? 800));
  });

  socket.on("speech:staff", (p) => {
    if (p.isFinal) {
      onEvent({
        type: "staffDelivered", sessionId: p.sessionId, text: p.text,
        translatedText: p.translatedText,
        translationFailed: p.translationFailed, voiceFailed: p.voiceFailed, at: Date.now(),
      });
    }
  });

  socket.on("error:translation", (p) => onEvent({ type: "translationError", ...p, at: Date.now() }));
  socket.on("call:ended", (p) => { calls.delete(p.sessionId); });
  socket.on("call:userDisconnected", (p) => onEvent({ type: "userDisconnected", ...p, at: Date.now() }));

  return {
    /**
     * この通話で使う台本を登録する。
     * @param {string[]} replies 係員の返事（日本語）
     * @param {string[]} audio   返事を読み上げた音声ファイル。渡すと係員は声で話す
     */
    setReplies(sessionId, replies, audio = null) {
      const c = calls.get(sessionId) ?? { turn: 0, done: 0 };
      c.replies = replies;
      c.done = 0;
      c.audio = audio;
      c.turn = 0;
      calls.set(sessionId, c);
    },
    endCall(sessionId) {
      socket.emit("call:end", { sessionId });
    },
    /** 係員画面からお客様のマイクをON／OFFする（異常系試験で使う）。 */
    setUserMic(sessionId, on) {
      socket.emit("staff:setUserMic", { sessionId, on });
    },
    /** 係員がいま話している最中か。 */
    isSpeaking() { return speaking !== null; },
    /**
     * 指定した往復の返事が終わるまで待つ。
     * ★「話し始めるのを待ってから終わるのを待つ」方式だと、返事が速いときに
     *   始まりを見逃して待ち続けてしまう（2026-08-19 に90秒の空回りが発生）。
     *   往復番号で「終わったか」を見るこの方式なら取りこぼさない。
     */
    async waitTurn(sessionId, seq, timeoutMs = 90000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const c = calls.get(sessionId);
        if (c && (c.done ?? 0) >= seq && speaking === null) return true;
        await sleep(200);
      }
      log("疑似係員", `⚠ 返事(${seq})が時間内に終わりませんでした`);
      return false;
    },
    /** 応答済みの通話があるか（異常系試験の待ち合わせに使う）。 */
    hasCall(sessionId) {
      return calls.has(sessionId);
    },
    /** 通信そのものを切る（係員側の切断を起こす）。 */
    cutConnection() {
      socket.disconnect();
    },
    get refusedCount() { return refused; },
    async stop() {
      try { socket.emit("staff:setStatus", { status: "away" }); } catch { /* 切断済み */ }
      await new Promise((r) => setTimeout(r, 200));
      socket.disconnect();
      log("疑似係員", "停止しました");
    },
  };
}
