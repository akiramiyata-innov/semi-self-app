"use client";

import { useEffect, useState } from "react";
import { PhoneCall, PhoneOff } from "lucide-react";
import { SUPPORTED_LANGS } from "@/lib/languages";
import { ScreenShareView } from "./ScreenShareView";
import type { LangCode } from "@/lib/socketEvents";

interface CallQueueItemProps {
  sessionId: string;
  machineId: string;
  machineName: string;
  userLang?: LangCode;
  timestamp: number;
  taken?: boolean;
  /** Face-camera preview so staff can see who's calling before answering */
  faceFrame?: string | null;
  onAnswer: () => void;
  onReject?: () => void;
}

function elapsed(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${s % 60}秒`;
}

export function CallQueueItem({
  machineName,
  userLang,
  timestamp,
  taken,
  faceFrame,
  onAnswer,
  onReject,
}: CallQueueItemProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const lang = SUPPORTED_LANGS.find((l) => l.code === userLang);

  return (
    <div
      className={`call-queue-item flex items-center gap-3 rounded-xl border p-3 transition-all ${
        taken
          ? "border-gray-200 bg-gray-50 opacity-50"
          : "border-red-200 bg-red-50 shadow-sm"
      }`}
    >
      <div className="relative shrink-0">
        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${taken ? "bg-gray-200" : "bg-red-500"}`}>
          <PhoneCall className="text-white" size={18} />
        </div>
        {!taken && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-red-500" />
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm truncate">{machineName}</p>
        {/* Language badge */}
        {lang && (
          <span className="inline-flex items-center gap-1 text-xs text-gray-600 mt-0.5">
            <span>{lang.flag}</span>
            <span>{lang.label}</span>
          </span>
        )}
        <p className="text-xs text-gray-500 mt-0.5">{taken ? "対応中" : `${elapsed(timestamp)} 待機中`}</p>
      </div>

      {!taken && faceFrame && (
        <div className="w-14 h-14 shrink-0">
          <ScreenShareView frameData={faceFrame} label="顔" className="w-full h-full" />
        </div>
      )}

      {!taken && (
        <div className="flex items-center gap-1.5 shrink-0">
          {onReject && (
            <button
              onClick={onReject}
              className="flex items-center gap-1 bg-gray-200 hover:bg-gray-300 text-gray-700 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
              title="呼び出しを拒否"
            >
              <PhoneOff size={12} />
              拒否
            </button>
          )}
          <button
            onClick={onAnswer}
            className="bg-green-500 hover:bg-green-600 text-white text-sm font-semibold px-4 py-1.5 rounded-lg transition-colors"
          >
            応答
          </button>
        </div>
      )}
    </div>
  );
}
