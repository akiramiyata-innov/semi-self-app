"use client";

import { useEffect, useRef } from "react";
import type { TranscriptEntry } from "@/lib/types";

export type { TranscriptEntry };

interface TranscriptPanelProps {
  entries: TranscriptEntry[];
  interimUserText?: string;
  interimStaffText?: string;
  /**
   * お客様の言語名（例「英語」）。訳文の見出しに使う。
   * お客様の発話の訳文は日本語、係員の発話の訳文はお客様の言語になるため、
   * 話者によって見出しを変える必要がある。
   */
  userLangLabel?: string;
}

export function TranscriptPanel({ entries, interimUserText, interimStaffText, userLangLabel }: TranscriptPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, interimUserText, interimStaffText]);

  return (
    <div className="flex flex-col gap-2 overflow-y-auto h-full px-2 py-2">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className={`flex flex-col max-w-[80%] ${
            entry.speaker === "user" ? "self-end items-end" : "self-start items-start"
          }`}
        >
          <span className="text-xs text-gray-400 mb-0.5">
            {entry.speaker === "user" ? "お客様" : "駅員"}
          </span>
          <div
            className={`rounded-2xl px-4 py-2 text-sm ${
              entry.speaker === "user"
                ? "bg-blue-500 text-white rounded-tr-sm"
                : "bg-gray-100 text-gray-800 rounded-tl-sm"
            }`}
          >
            {entry.text}
          </div>
          {entry.translatedText && entry.translatedText !== entry.text && (
            <div
              className={`mt-1 rounded-xl px-3 py-1.5 text-sm border max-w-full ${
                entry.speaker === "user"
                  ? "bg-blue-50 border-blue-200 text-blue-800"
                  : "bg-yellow-50 border-yellow-200 text-yellow-800"
              }`}
            >
              <span className="text-[10px] font-bold mr-1.5 opacity-50">
                🔤 {entry.speaker === "user" ? "日本語" : (userLangLabel ?? "訳文")}
              </span>
              {entry.translatedText}
            </div>
          )}
          {/* 「確定前の返答」の印（v1.52.0）。お客様の発言があとから上に差し込まれた
              とき、その直後の係員の返答に付く＝その発言を見ないうちに答えていた可能性。
              係員が「答えた内容で合っているか」を確かめるきっかけにする。 */}
          {entry.speaker === "staff" && entry.earlyReply && (
            <div className="mt-1">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200">
                ↑ お客様の発言が確定する前の返答
              </span>
            </div>
          )}
          {/* 失敗の印。通知（トースト）は4秒で消えるため、発言そのものに残して
              後から見返しても分かるようにする。 */}
          {(entry.translationFailed || entry.voiceFailed) && (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.translationFailed && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">
                  ⚠ 翻訳できませんでした
                </span>
              )}
              {entry.voiceFailed && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">
                  ⚠ 音声が届きませんでした
                </span>
              )}
            </div>
          )}
        </div>
      ))}

      {interimStaffText && (
        <div className="flex flex-col max-w-[80%] self-start items-start">
          <span className="text-xs text-gray-400 mb-0.5">駅員</span>
          <div className="rounded-2xl rounded-tl-sm px-4 py-2 text-sm bg-gray-100 text-gray-400 italic">
            {interimStaffText}
          </div>
        </div>
      )}

      {interimUserText && (
        <div className="flex flex-col max-w-[80%] self-end items-end">
          <span className="text-xs text-gray-400 mb-0.5">お客様</span>
          <div className="rounded-2xl rounded-tr-sm px-4 py-2 text-sm bg-blue-300 text-white italic">
            {interimUserText}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
