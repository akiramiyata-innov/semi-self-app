"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, MessageSquare, ChevronRight } from "lucide-react";
import { TranscriptPanel } from "@/components/TranscriptPanel";
import { SUPPORTED_LANGS } from "@/lib/languages";
import type { SessionLog, SessionSummary } from "@/lib/types";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}秒`;
  return `${Math.floor(secs / 60)}分${secs % 60}秒`;
}

export default function LogsPage() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionLog | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    fetch("/api/logs")
      .then((r) => r.json())
      .then((data) => setSessions(data.sessions ?? []))
      .finally(() => setLoading(false));
  }, []);

  const selectSession = async (sessionId: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/logs/${sessionId}`);
      if (r.ok) setSelected(await r.json());
    } finally {
      setDetailLoading(false);
    }
  };

  const getLangLabel = (code: string) => {
    const l = SUPPORTED_LANGS.find((s) => s.code === code);
    return l ? `${l.flag} ${l.label}` : code;
  };

  return (
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 shrink-0 flex items-center gap-4">
        <Link
          href="/staff"
          className="flex items-center gap-1.5 text-gray-500 hover:text-blue-600 text-sm transition-colors"
        >
          <ArrowLeft size={14} />
          スタッフ画面
        </Link>
        <h1 className="font-bold text-gray-900 text-sm">通話ログ</h1>
        <span className="text-xs text-gray-400 ml-auto">
          {loading ? "読み込み中..." : `${sessions.length}件`}
        </span>
      </header>

      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Session list */}
        <aside className="w-80 shrink-0 border-r border-gray-200 bg-white overflow-y-auto">
          {loading && (
            <div className="p-6 text-center text-gray-400 text-sm">読み込み中...</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="p-6 text-center text-gray-400 text-sm">
              <div className="text-3xl mb-2">📋</div>
              <p>通話ログがありません</p>
              <p className="text-xs mt-1">通話終了後に自動保存されます</p>
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => selectSession(s.sessionId)}
              className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-blue-50 transition-colors flex items-start gap-3 ${
                selected?.sessionId === s.sessionId ? "bg-blue-50 border-l-2 border-l-blue-500" : ""
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-sm text-gray-800 truncate">{s.machineName}</span>
                  <span className="text-xs text-gray-400 shrink-0">{getLangLabel(s.userLang)}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">{formatTime(s.startedAt)}</div>
                <div className="flex items-center gap-3 mt-1 text-xs text-gray-400">
                  <span className="flex items-center gap-0.5">
                    <Clock size={10} />
                    {formatDuration(s.durationSeconds)}
                  </span>
                  <span className="flex items-center gap-0.5">
                    <MessageSquare size={10} />
                    {s.messageCount}件
                  </span>
                </div>
              </div>
              <ChevronRight size={14} className="text-gray-300 shrink-0 mt-1" />
            </button>
          ))}
        </aside>

        {/* Detail panel */}
        <main className="flex-1 overflow-hidden flex flex-col min-w-0">
          {detailLoading && (
            <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
              読み込み中...
            </div>
          )}
          {!detailLoading && !selected && (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
              <div className="text-4xl mb-3">💬</div>
              <p className="text-sm font-medium">セッションを選択してください</p>
              <p className="text-xs mt-1">左のリストからログを選ぶと会話内容が表示されます</p>
            </div>
          )}
          {!detailLoading && selected && (
            <>
              {/* Session info bar */}
              <div className="bg-white border-b border-gray-200 px-6 py-3 shrink-0">
                <div className="flex items-center gap-4 flex-wrap text-sm text-gray-600">
                  <span className="font-semibold text-gray-900">{selected.machineName}</span>
                  <span>{getLangLabel(selected.userLang)}</span>
                  <span className="flex items-center gap-1">
                    <Clock size={12} />
                    {formatDuration(selected.durationSeconds)}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageSquare size={12} />
                    {selected.transcript.length}件の発言
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">{formatTime(selected.startedAt)}</span>
                </div>
              </div>
              {/* Transcript */}
              <div className="flex-1 overflow-y-auto p-4">
                <TranscriptPanel entries={selected.transcript} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
