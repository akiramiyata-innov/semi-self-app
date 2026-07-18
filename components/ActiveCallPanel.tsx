"use client";

import { useRef, useState } from "react";
import { Monitor, MonitorOff, Mic, MicOff, PhoneOff, Send } from "lucide-react";
import { TranscriptPanel } from "./TranscriptPanel";
import { ScreenShareView } from "./ScreenShareView";
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
  isCapturing: boolean;
  isListening: boolean;
  micError?: string | null;
  onToggleMic: () => void;
  onToggleScreenShare: () => void;
  onEnd: () => void;
  /** Called when staff submits text manually (fallback for mic) */
  onSendText?: (text: string) => void;
  /** Staff's saved quick-reply phrases, shown as one-tap send buttons. */
  quickReplies?: string[];
}

export function ActiveCallPanel({
  machineName,
  userLang,
  transcript,
  interimUserText,
  interimStaffText,
  userCameraFaceFrame,
  isCapturing,
  isListening,
  micError,
  onToggleMic,
  onToggleScreenShare,
  onEnd,
  onSendText,
  quickReplies,
}: ActiveCallPanelProps) {
  const [inputText, setInputText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const lang = SUPPORTED_LANGS.find((l) => l.code === userLang);

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
      className={`flex flex-col h-full bg-white rounded-xl border-2 shadow overflow-hidden transition-all ${
        isListening
          ? "border-red-500 ring-4 ring-red-300/60 shadow-lg shadow-red-200"
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
              <span>{lang.flag}</span>
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
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onToggleMic}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isListening
                ? "bg-red-500 text-white hover:bg-red-600 ring-2 ring-red-300"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
            title={isListening ? "マイクOFF (Space)" : "マイクON (Space)"}
          >
            {isListening ? <Mic size={14} /> : <MicOff size={14} />}
            {isListening ? "マイクON" : "マイクOFF"}
            <span className="text-[10px] opacity-50 ml-0.5">[Space]</span>
          </button>
          <button
            onClick={onToggleScreenShare}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
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
            onClick={onEnd}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-600 transition-colors"
            title="対話終了"
          >
            <PhoneOff size={14} />
            終了
          </button>
        </div>
      </div>

      {/* Mic error */}
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
          />
        </div>

        {/* Camera feed from kiosk: 券面カメラ */}
        {userCameraFaceFrame && (
          <div className="w-56 border-l border-gray-100 p-2 shrink-0 flex flex-col gap-2 overflow-y-auto">
            <ScreenShareView
              frameData={userCameraFaceFrame}
              label="券面カメラ"
              className="h-40 shrink-0"
            />
          </div>
        )}
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
