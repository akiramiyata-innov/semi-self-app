"use client";

import { useEffect, useRef } from "react";

export interface TranscriptEntry {
  id: string;
  speaker: "user" | "staff";
  text: string;
  translatedText?: string;
  isFinal: boolean;
  timestamp: number;
}

interface TranscriptPanelProps {
  entries: TranscriptEntry[];
  interimUserText?: string;
  interimStaffText?: string;
}

export function TranscriptPanel({ entries, interimUserText, interimStaffText }: TranscriptPanelProps) {
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
              <span className="text-[10px] font-bold mr-1.5 opacity-50">🔤 日本語</span>
              {entry.translatedText}
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
