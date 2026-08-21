"use client";

import { useEffect, useRef, useState } from "react";
import { Monitor, MonitorOff, Mic, MicOff, PhoneOff, Send, MessageSquareText, MessageSquareOff, VideoOff, Volume2, VolumeX } from "lucide-react";
import { TranscriptPanel } from "./TranscriptPanel";
import { ScreenShareView } from "./ScreenShareView";
import { Flag } from "./Flag";
import { SUPPORTED_LANGS } from "@/lib/languages";
import type { TranscriptEntry } from "@/lib/types";
import type { LangCode } from "@/lib/socketEvents";

interface ActiveCallPanelProps {
  sessionId: string;
  machineName: string;
  userLang?: LangCode;
  transcript: TranscriptEntry[];
  interimUserText?: string;
  interimStaffText?: string;
  userCameraFaceFrame?: string | null;
  /** 券面カメラの映像が最後に届いた時刻。しばらく届いていなければ「映像なし」に切り替える。 */
  userCameraFaceFrameAt?: number | null;
  /** お客様側から申告されたカメラ異常の説明。「映像なし」の枠に理由として出す。 */
  userCameraError?: string | null;
  isCapturing: boolean;
  isListening: boolean;
  /**
   * Space キーでマイクを操作できる状態か。2件同時通話中と画面共有中は false になり、
   * マイクボタンの「[Space]」表示を消す（使えないのに使えるように見えるのを防ぐ）。
   */
  spaceShortcut?: boolean;
  micError?: string | null;
  onToggleMic: () => void;
  onToggleScreenShare: () => void;
  onEnd: () => void;
  /** Called when staff submits text manually (fallback for mic) */
  onSendText?: (text: string) => void;
  /** 入力欄に文字があるか（お客様側の「回答を準備しています」表示に使う）。 */
  onTypingChange?: (typing: boolean) => void;
  /** お客様が今話しているか（「お客様発話中」の表示に使う）。 */
  userSpeaking?: boolean;
  /** Staff's saved quick-reply phrases, shown as one-tap send buttons. */
  quickReplies?: string[];
  /**
   * 通話が1件だけで画面を独占しているか。券面カメラを大きく表示してよい状態を指す。
   * 複数通話で画面が分割されているときは場所が足りないので従来の大きさのままにする。
   */
  soloView?: boolean;
  /**
   * お客様の画面に会話のテキストが出ているか（既定は非表示）。係員の画面には常に
   * テキストが出ているため、お客様にも見えている前提で話してしまわないよう、
   * 状態をはっきり表示する。
   */
  textVisible?: boolean;
  /** お客様画面のテキスト表示を切り替える。お客様側の操作と対等（後勝ち）。 */
  onToggleText?: () => void;
  /**
   * お客様側のマイク異常（null＝異常なし）。係員からは「話さないお客様」にしか
   * 見えないため、原因を切り分けられるよう常時表示する。
   */
  userMicError?: string | null;
  /** お客様マイクの今の状態。on=聞き取り中／paused=読み上げ中の自動一時停止／off=OFF。 */
  userMicState?: "on" | "paused" | "off";
  /** お客様マイクを係員側から入/切する。お客様側の操作と対等（後勝ち）。 */
  onSetUserMic?: (on: boolean) => void;
  /**
   * お客様の生の声をこの画面で鳴らしているか（v1.42.0・既定はOFF）。
   * 文字起こしの取り逃し・遅れ・書き間違いを耳で補うための機能。
   */
  listenUserAudio?: boolean;
  /**
   * 「お客様の声」はONだが、係員自身のマイクが入っているため今は鳴らしていない状態。
   * スピーカーの声を自分のマイクが拾う「回り込み」を防ぐための自動停止。
   */
  listenPaused?: boolean;
  /** 「お客様の声」を入/切する。 */
  onToggleListenUser?: () => void;
}

export function ActiveCallPanel({
  machineName,
  userLang,
  transcript,
  interimUserText,
  interimStaffText,
  userCameraFaceFrame,
  userCameraFaceFrameAt,
  userCameraError,
  isCapturing,
  isListening,
  spaceShortcut = true,
  micError,
  onToggleMic,
  onToggleScreenShare,
  onEnd,
  onSendText,
  onTypingChange,
  userSpeaking,
  quickReplies,
  soloView = false,
  textVisible = false,
  onToggleText,
  userMicError,
  userMicState = "off",
  onSetUserMic,
  listenUserAudio = false,
  listenPaused = false,
  onToggleListenUser,
}: ActiveCallPanelProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const lang = SUPPORTED_LANGS.find((l) => l.code === userLang);

  // 券面カメラの「映像なし」判定（C-1）。最後のフレームから8秒（送信は0.2秒間隔）
  // 届かなければ途絶とみなす。時間の経過で表示が変わるよう、2秒ごとに現在時刻を刻む。
  const CAMERA_STALE_MS = 8000;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(t);
  }, []);
  const cameraLive = !!userCameraFaceFrame
    && userCameraFaceFrameAt != null
    && nowTick - userCameraFaceFrameAt < CAMERA_STALE_MS;

  const onTypingChangeRef = useRef(onTypingChange);
  useEffect(() => { onTypingChangeRef.current = onTypingChange; }, [onTypingChange]);
  // 入力欄に文字があるかを親へ通知。通話パネルが閉じたら必ず解除する（表示が残らないように）。
  useEffect(() => {
    onTypingChangeRef.current?.(inputText.trim().length > 0);
  }, [inputText]);
  useEffect(() => () => { onTypingChangeRef.current?.(false); }, []);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text) return;
    onSendText?.(text);
    setInputText("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !e.repeat) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      /* お客様が話している間は枠も色を変える。2件同時対応で画面が小さいときや、
         視線が別のところにあるときでも、目の端で気づけるようにするため。 */
      className={`flex flex-col h-full bg-white rounded-xl border-2 shadow overflow-hidden transition-all ${
        isListening
          ? "border-red-500 ring-4 ring-red-300/60 shadow-lg shadow-red-200"
          : userSpeaking
          ? "border-amber-400 ring-4 ring-amber-300/60 shadow-lg shadow-amber-200"
          : isCapturing
          ? "border-purple-400 shadow-purple-100"
          : "border-gray-200"
      }`}
    >
      {/* マイクON 大きく目立つバナー（あなたの声がお客様に届いている状態） */}
      {isListening && (
        <div className="flex items-center justify-center gap-2.5 bg-red-600 text-white px-4 py-2.5 shrink-0">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-200 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-white" />
          </span>
          <Mic size={18} className="shrink-0" />
          <span className="font-bold text-sm sm:text-base tracking-wide">マイクON　あなたの声がお客様に届いています</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-green-50 border-b border-green-200 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
          <span className="font-semibold text-sm">{machineName} — 通話中</span>

          {/* User language badge */}
          {lang && (
            <span className="flex items-center gap-1 bg-white border border-gray-300 text-gray-700 text-xs px-2 py-0.5 rounded-full">
              <Flag code={lang.code} size={18} />
              <span>{lang.label}</span>
            </span>
          )}

          {isCapturing && (
            <span className="flex items-center gap-1 bg-purple-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-200 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
              </span>
              LIVE 共有中
            </span>
          )}

          {isListening && (
            <span className="flex items-center gap-1 bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-200 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-white" />
              </span>
              録音中
            </span>
          )}

          {/* ※「お客様にテキスト表示中／非表示」の札は v1.58.0 で削除した（ユーザー指示）。
              右のボタン列の「お客様画面テキスト ON/OFF」と同じ情報で、二重に出ていたため。 */}
        </div>

        {/* ★2件同時のように幅が狭いときは、ボタンを縮めずに次の行へ折り返す。
            縮めると「画面共/有」「終/了」のように語の途中で改行され、とっさに読めない。 */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={onToggleMic}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isListening
                ? "bg-red-500 text-white hover:bg-red-600 ring-2 ring-red-300"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={
              spaceShortcut
                ? (isListening ? "マイクOFF (Space)" : "マイクON (Space)")
                : (isListening ? "マイクOFF" : "マイクON")
            }
          >
            {isListening ? <Mic size={14} /> : <MicOff size={14} />}
            {isListening ? "マイクON" : "マイクOFF"}
            {spaceShortcut && <span className="text-[10px] opacity-50 ml-0.5">[Space]</span>}
          </button>
          <button
            onClick={onToggleScreenShare}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isCapturing
                ? "bg-purple-500 text-white hover:bg-purple-600"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={isCapturing ? "画面共有停止" : "画面共有開始"}
          >
            {isCapturing ? <Monitor size={14} /> : <MonitorOff size={14} />}
            {isCapturing ? "共有停止" : "画面共有"}
          </button>
          <button
            onClick={onToggleText}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              textVisible
                ? "bg-sky-600 text-white hover:bg-sky-700"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={textVisible ? "お客様画面のテキスト表示をOFFにする" : "お客様画面にテキストを表示する"}
          >
            {textVisible ? <MessageSquareText size={14} /> : <MessageSquareOff size={14} />}
            {textVisible ? "お客様画面テキストON" : "お客様画面テキストOFF"}
          </button>
          {/* お客様マイクの入/切。一時停止(paused)は読み上げ中の自動停止＝すぐ再開されるので、
              ボタンとしては「ONの仲間」（押せばOFFにできる）として扱う。 */}
          <button
            onClick={() => onSetUserMic?.(userMicState === "off")}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              userMicState === "on"
                ? "bg-pink-600 text-white hover:bg-pink-700"
                : userMicState === "paused"
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={userMicState === "off" ? "お客様のマイクをONにする" : "お客様のマイクをOFFにする"}
          >
            {userMicState === "off" ? <MicOff size={14} /> : <Mic size={14} />}
            {userMicState === "on" ? "お客様マイクON" : userMicState === "paused" ? "お客様マイク停止中" : "お客様マイクOFF"}
          </button>
          {/* お客様の生の声をこの画面で聞く（v1.42.0・既定はOFF）。
              係員自身のマイクが入っている間は回り込み防止のため自動で止まる（琥珀色）。 */}
          <button
            onClick={onToggleListenUser}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              listenUserAudio && listenPaused
                ? "bg-amber-500 text-white hover:bg-amber-600"
                : listenUserAudio
                  ? "bg-teal-600 text-white hover:bg-teal-700"
                  : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={
              listenUserAudio && listenPaused
                ? "自分のマイクが入っている間は、声の回り込みを防ぐため鳴らしません（マイクを切れば戻ります）"
                : listenUserAudio
                  ? "お客様音声を鳴らすのをやめる"
                  : "お客様音声をこの画面のスピーカーで聞く"
            }
          >
            {listenUserAudio && !listenPaused ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {listenUserAudio && listenPaused ? "お客様音声 停止中" : listenUserAudio ? "お客様音声 ON" : "お客様音声 OFF"}
          </button>
          <button
            onClick={onEnd}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors"
            title="対話終了"
          >
            <PhoneOff size={14} />
            終了
          </button>
        </div>
      </div>

      {/* お客様側のマイク異常。トーストは4秒で消えるので、続いている間は帯で出し続ける。 */}
      {userMicError && (
        <div className="bg-orange-50 border-b border-orange-300 px-3 py-1.5 flex items-center gap-2 shrink-0">
          <MicOff size={14} className="text-orange-700 shrink-0" />
          <span className="text-orange-800 text-xs font-bold">{userMicError}</span>
          <span className="text-orange-700 text-xs">お客様の声が届きません。テキスト送信でご案内してください。</span>
        </div>
      )}

      {/* Mic error（係員自身） */}
      {micError && (
        <div className="bg-red-50 border-b border-red-200 px-3 py-1.5 text-red-700 text-xs whitespace-pre-line shrink-0">
          ⚠️ {micError}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Transcript */}
        <div className="flex-1 overflow-y-auto min-w-0">
          <TranscriptPanel
            entries={transcript}
            interimUserText={interimUserText}
            interimStaffText={interimStaffText}
            userLangLabel={lang?.label}
          />
        </div>

        {/* Camera feed from kiosk: 券面カメラ。
            1件だけ対応しているときは券面の文字が読み取りやすいよう倍の大きさで出す。
            ★映像が無いときも枠を出し「映像なし」と示す（C-1）。従来は枠ごと消えていた
            ため、カメラの不調に係員が気づけず、切り分けの手がかりも残らなかった。 */}
        <div className={`border-l border-gray-100 p-2 shrink-0 flex flex-col gap-2 overflow-y-auto ${soloView ? "w-[28rem]" : "w-56"}`}>
          {cameraLive ? (
            <ScreenShareView
              frameData={userCameraFaceFrame!}
              label="券面カメラ"
              className={`shrink-0 ${soloView ? "h-80" : "h-40"}`}
            />
          ) : (
            <div
              className={`shrink-0 ${soloView ? "h-80" : "h-40"} rounded-lg bg-gray-100 border-2 border-dashed border-gray-300 flex flex-col items-center justify-center gap-1.5 px-2 text-center`}
            >
              <VideoOff size={soloView ? 28 : 20} className="text-gray-400" />
              <span className="text-xs font-bold text-gray-500">券面カメラ　映像なし</span>
              <span className="text-[10px] text-orange-600 font-medium leading-snug">
                {userCameraError
                  ?? (userCameraFaceFrame ? "映像が途絶えています" : "お客様側から映像が届いていません")}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Quick-reply buttons (one-tap send of saved phrases) ── */}
      {quickReplies && quickReplies.length > 0 && (
        <div className="border-t border-gray-200 px-3 pt-2 bg-gray-50 shrink-0">
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {quickReplies.map((phrase, i) => (
              <button
                key={i}
                onClick={() => onSendText?.(phrase)}
                title={phrase}
                className="shrink-0 max-w-[220px] truncate px-2.5 py-1 bg-white border border-indigo-200 text-indigo-700 text-xs rounded-full hover:bg-indigo-50 transition-colors"
              >
                {phrase}
              </button>
            ))}
          </div>
        </div>
      )}

      {/*
        お客様が話している間の案内。**画面のいちばん下**（入力欄の真上）に出す。
        会話が伸びると係員の目線は下（最新の発言と入力欄）に移るため、画面の上に置くと
        視界から外れ、かぶせて話す原因になっていた（2026-08-15 ユーザー指摘）。
        確定テキストが出るまで点灯し続ける（息継ぎでは消えない）。点灯はお客様のマイクの
        ON/OFFではなく、実際の声の大きさで判定している。
        係員自身のマイクもONのときは「声が重なっている」状態なので、赤で強く知らせる。
      */}
      {userSpeaking && (
        <div
          className={`flex items-center justify-center gap-2.5 px-4 py-2.5 shrink-0 ${
            isListening ? "bg-red-600 text-white" : "bg-amber-400 text-amber-950"
          }`}
        >
          <span className="relative flex h-3 w-3 shrink-0">
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                isListening ? "bg-red-200" : "bg-amber-700"
              }`}
            />
            <span
              className={`relative inline-flex rounded-full h-3 w-3 ${
                isListening ? "bg-white" : "bg-amber-800"
              }`}
            />
          </span>
          <Mic size={18} className="shrink-0" />
          <span className="font-bold text-sm sm:text-base tracking-wide">
            {isListening
              ? "お客様が話しています　声が重なっています"
              : "お客様が話しています　お待ちください"}
          </span>
        </div>
      )}

      {/* ── Text input fallback ── */}
      <div className="border-t border-gray-200 px-3 py-2 bg-gray-50 shrink-0">
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isListening ? "マイクON中（テキスト入力も可）" : "テキストで送信（Enterキー）"}
            className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white placeholder:text-gray-400"
          />
          <button
            onClick={handleSend}
            disabled={!inputText.trim()}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-xs font-medium rounded-lg transition-colors"
          >
            <Send size={13} />
            送信
          </button>
        </div>
      </div>
    </div>
  );
}
