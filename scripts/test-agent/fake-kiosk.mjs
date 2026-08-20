/**
 * 疑似お客様（窓処端末の代わり）。
 *
 * 用意した音声ファイルを、本番のキオスクとまったく同じ形（16kHz・16bit・モノラルの
 * 生の音を100ミリ秒ずつ）で、実際の速さで流し込む。したがって音声認識・翻訳・読み上げは
 * 本番と同じ道を通る。ブラウザは使わない。
 *
 * 端末名・端末IDは必ず "test-" で始める（疑似係員はこれを見て応答を判断する）。
 */
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { io } from "socket.io-client";

const execFileAsync = promisify(execFile);
import { AUDIO, TEST_PREFIX, log, roomTone, targetUrl } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 音声データ（MP3）の長さを秒で返す。アバターが話す時間（T7）を測るのに使う。
 * ffprobe が無い環境では null を返し、測定はとばす。
 */
async function audioSeconds(buf) {
  if (!buf || buf.length === 0) return null;
  const file = path.join(tmpdir(), `tts-${process.pid}-${Date.now()}.mp3`);
  try {
    await writeFile(file, buf);
    const { stdout } = await execFileAsync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
    const sec = parseFloat(String(stdout).trim());
    return Number.isFinite(sec) ? Math.round(sec * 100) / 100 : null;
  } catch {
    return null;
  } finally {
    await unlink(file).catch(() => {});
  }
}

/**
 * @param {object} opts
 * @param {string} opts.machineId    "test-zh-01" のように test- で始める
 * @param {string} opts.machineName  "test-zh-01" のように test- で始める
 * @param {string} opts.stationId    テスト専用駅のID
 * @param {string} opts.lang         アプリの言語コード（ja / en / zh …）
 * @param {string} opts.bcp47        音声認識に渡す言語（ja-JP / cmn-Hans-CN …）
 */
export async function startFakeKiosk({ machineId, machineName, stationId, lang, bcp47, onEvent = () => {} }) {
  if (!machineId.startsWith(TEST_PREFIX) || !machineName.startsWith(TEST_PREFIX)) {
    throw new Error(`端末IDと端末名は "${TEST_PREFIX}" で始めてください（疑似係員がテストだと判断できません）`);
  }
  const socket = io(targetUrl(), { transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    setTimeout(() => reject(new Error("疑似お客様がつながりません")), 15000);
  });

  let sessionId = null;
  let answered = null;
  const answeredPromise = new Promise((r) => { answered = r; });
  /** 返答の音声が全部届いたことを待つための仕掛け */
  let ttsDone = null;
  let audioCount = 0;
  let lastAudioAt = 0;   // 最後に音声が届いた時刻（届き切ったかの判定に使う）

  // 呼び出した直後にサーバーが通話IDを返してくる（応答より前）
  socket.on("disconnect", (reason) => {
    log("疑似お客様", `⚠ 接続が切れました（${reason}）`);
    onEvent({ type: "kioskDisconnected", reason, at: Date.now() });
  });
  socket.io.on("reconnect", () => {
    log("疑似お客様", "⚠ つなぎ直しました");
    onEvent({ type: "kioskReconnected", at: Date.now() });
  });
  socket.on("call:requested", (p) => { sessionId = p.sessionId; });
  socket.on("call:answered", (p) => {
    sessionId = p.sessionId;
    onEvent({ type: "answered", sessionId, staffName: p.staffName, at: Date.now() });
    answered(p);
  });
  socket.on("call:timeout", () => onEvent({ type: "callTimeout", at: Date.now() }));
  socket.on("call:rejected", () => onEvent({ type: "callRejected", at: Date.now() }));
  socket.on("call:noStaff", () => onEvent({ type: "noStaff", at: Date.now() }));
  socket.on("speech:staff", (p) => {
    if (p.isFinal) onEvent({ type: "staffTextArrived", sessionId: p.sessionId, text: p.text, at: Date.now() });
  });
  // 届いた読み上げ音声を貯めておく。あとで長さ（＝アバターが話す時間・T7）を測る。
  let ttsChunks = [];
  socket.on("tts:audio", (p) => {
    audioCount++;
    lastAudioAt = Date.now();
    if (p?.audioBase64) ttsChunks.push(Buffer.from(p.audioBase64, "base64"));
    onEvent({ type: "ttsAudio", bytes: p?.audioBase64?.length ?? 0, at: Date.now() });
  });
  socket.on("tts:done", () => { lastAudioAt = Date.now(); onEvent({ type: "ttsDone", at: Date.now() }); ttsDone?.(); });
  // 本物のキオスクと同じ流れ：認識が確定したら、それを発言として係員へ送る
  // （UserScreen.tsx の onFinal と同じ。これが無いと係員には何も届かない）
  let clientSeq = 0;
  let finalSeen = false;   // 話し終わったあと、確定が返ってきたか（環境音を止める合図）
  socket.on("stt:final", (p) => {
    finalSeen = true;
    onEvent({ type: "sttFinal", text: p.transcript, at: Date.now() });
    if (!p.transcript || !sessionId) return;
    const clientId = `k-${++clientSeq}`;
    socket.emit("speech:user", { sessionId, text: p.transcript, lang, isFinal: true, clientId });
    onEvent({ type: "userSent", text: p.transcript, clientId, at: Date.now() });
  });
  socket.on("speech:delivered", (p) => onEvent({ type: "delivered", clientId: p.clientId, at: Date.now() }));
  socket.on("stt:interim", (p) => onEvent({ type: "sttInterim", text: p.transcript, at: Date.now() }));
  socket.on("stt:error", (p) => onEvent({ type: "sttError", message: p.message, at: Date.now() }));
  let lastMicCommand = null;
  let endedReason = null;
  socket.on("call:ended", (p) => { endedReason = p?.reason ?? "ended"; onEvent({ type: "callEnded", reason: p?.reason, at: Date.now() }); });
  // 係員からのマイク遠隔操作（本物のキオスクはこれでマイクを入切する）
  socket.on("user:micControl", (p) => {
    lastMicCommand = p?.on ? "on" : "off";
    onEvent({ type: "micCommand", on: !!p?.on, at: Date.now() });
    socket.emit("user:micState", { sessionId, state: p?.on ? "on" : "off" });
  });

  return {
    get sessionId() { return sessionId; },

    /** 係員を呼び出し、応答されるまで待つ。 */
    async call({ timeoutMs = 70000 } = {}) {
      const t0 = Date.now();
      socket.emit("call:request", { machineId, machineName, userLang: lang, stationId });
      onEvent({ type: "called", at: t0 });
      log("疑似お客様", `呼び出しました（${machineName} / ${lang}）`);
      const res = await Promise.race([
        answeredPromise,
        sleep(timeoutMs).then(() => { throw new Error("応答されないまま時間切れ"); }),
      ]);
      log("疑似お客様", `応答されました（${Date.now() - t0}ms）`);
      return res;
    },

    /**
     * 音声ファイル（16kHz・16bit・モノラルの生の音）を実時間で流し込む。
     * 話し終えたらマイクを止め、確定が出るのを待つ。
     */
    /**
     * @param {object} o
     * @param {boolean} o.keepMicOn マイクを切らずに終える（耐久試験用）
     */
    async speak(pcmPath, { tailMs = 5000, keepMicOn = false } = {}) {
      const pcm = await readFile(pcmPath);
      socket.emit("stt:start", { lang: bcp47 });
      socket.emit("user:micState", { sessionId, state: "on" });
      onEvent({ type: "speakStart", file: pcmPath, at: Date.now() });
      const size = AUDIO.chunkBytes;
      const started = Date.now();
      for (let i = 0, n = 0; i < pcm.length; i += size, n++) {
        socket.emit("stt:audio", pcm.subarray(i, Math.min(i + size, pcm.length)));
        // 実際の速さに合わせる（溜め込んで一気に送らない＝本番と同じ流れにする）
        const due = started + (n + 1) * AUDIO.chunkMs;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
      // ★送り出しが実時間に追いつけたかを見る。遅れると音声認識が途中で止まり、
      //   「アプリが悪い」ように見える誤った測定値になる（2026-08-19 中国語繁体で発生）。
      const audioSec = pcm.length / (AUDIO.sampleRate * AUDIO.bytesPerSample);
      const realSec = (Date.now() - started) / 1000;
      const lag = realSec / audioSec;
      onEvent({ type: "speakEnd", audioSec: Math.round(audioSec), realSec: Math.round(realSec), lag: Math.round(lag * 100) / 100, at: Date.now() });
      if (lag > 1.2) {
        log("疑似お客様", `⚠ 送り出しが実時間に追いつけませんでした（音声${Math.round(audioSec)}秒を${Math.round(realSec)}秒かけて送信＝${lag.toFixed(1)}倍）。この回の測定値は無効です。`);
      }
      // ★ここから確定を数え直す。話している最中に出た確定（間を取ったときに出る）で
      //   環境音を打ち切ってしまうと、後半の音声が認識される前にマイクを閉じてしまい、
      //   **アプリの問題のように見える誤った測定値**になる（2026-08-19 実際に発生）。
      //   本物のキオスクは確定が出てもマイクを開いたままにする（UserScreen.tsx:367）。
      finalSeen = false;
      // ★話し終えた後もマイクは開いたまま、環境音を流し続ける。
      //   本物の端末と同じで、認識AIはこの無音区間を見て「話し終わった」と判断する。
      //   送信をぷつりと止めると確定が返らない（2026-08-19 実測）。
      const tone = roomTone(pcm, tailMs);
      for (let i = 0; i < tone.length && !finalSeen; i += size) {
        socket.emit("stt:audio", tone.subarray(i, Math.min(i + size, tone.length)));
        await sleep(AUDIO.chunkMs);
      }
      await sleep(300);   // 確定の直後に切らない（本物の端末も少し余韻がある）
      if (keepMicOn) return; // 耐久試験ではマイクを切らない（本番のS11と同じ条件）
      socket.emit("stt:stop");
      socket.emit("user:micState", { sessionId, state: "off" });
    },

    /** 耐久試験の後始末（切らずに来たマイクをここで切る）。 */
    stopMic() {
      socket.emit("stt:stop");
      socket.emit("user:micState", { sessionId, state: "off" });
    },

    /** 係員の返答（文字と音声）が届き切るまで待つ。 */
    /**
     * 係員の返答が届き切るまで待つ。
     * ★長い発話は音声認識が複数回に分かれて確定するため、返答も複数のメッセージに
     *   分かれて届く（本物の係員画面と同じ）。そのため「1回 tts:done が来たら終わり」
     *   ではなく、**音声が来なくなるまで**待つ。
     */
    async waitReply({ timeoutMs = 60000, quietMs = 3000 } = {}) {
      audioCount = 0;
      ttsChunks = [];
      lastAudioAt = 0;
      const until = Date.now() + timeoutMs;
      let sawAny = false;
      while (Date.now() < until) {
        await sleep(250);
        if (audioCount > 0) sawAny = true;
        if (sawAny && lastAudioAt && Date.now() - lastAudioAt > quietMs) break;
      }
      if (!sawAny) log("疑似お客様", "⚠ 返答の音声が時間内に届きませんでした");
      // T7＝アバターが読み上げている時間。届いた音声そのものの長さを測る
      // （疑似お客様は音を鳴らさないので、ファイルの長さから求める）。
      const ttsSec = await audioSeconds(Buffer.concat(ttsChunks));
      if (ttsSec) onEvent({ type: "avatarSpeech", sec: ttsSec, pieces: audioCount, at: Date.now() });
      await sleep(500);
      return { ok: sawAny, audioCount, ttsSec };
    },

    async hangUp() {
      if (sessionId) socket.emit("call:end", { sessionId });
      await sleep(400);
    },

    async stop() {
      socket.disconnect();
    },

    // ── 異常系試験で使うもの ──────────────────────────────────────────
    /** 通信そのものを切る（WiFiが切れた状態を作る）。 */
    cutConnection() {
      socket.disconnect();
    },
    /** 係員から届いたマイクの遠隔操作を記録するため、直近の指示を返す。 */
    get lastMicCommand() { return lastMicCommand; },
    /** 通話が終わらされたか（同じ端末IDの取り合いなどを見るため）。 */
    get endedReason() { return endedReason; },
  };
}
