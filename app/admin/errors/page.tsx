"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, AlertTriangle } from "lucide-react";
import type { AppErrorEntry } from "@/lib/types";

// 種類コード → 日本語ラベルと色。未知の種類はそのまま表示する（将来の追加に耐える）。
const TYPE_LABELS: Record<string, { label: string; color: string }> = {
  "translate": { label: "翻訳失敗", color: "bg-red-100 text-red-700" },
  "tts-synthesis": { label: "音声合成失敗", color: "bg-red-100 text-red-700" },
  "tts-playback": { label: "音声再生失敗", color: "bg-red-100 text-red-700" },
  "logsave": { label: "ログ保存失敗", color: "bg-red-100 text-red-700" },
  "mic-user": { label: "お客様マイク異常", color: "bg-orange-100 text-orange-700" },
  "call-timeout": { label: "呼び出し未応答", color: "bg-orange-100 text-orange-700" },
  "stt-stream": { label: "音声認識の接続エラー", color: "bg-red-100 text-red-700" },
  "stt-guard-gate": { label: "認識ガード（無音）", color: "bg-gray-100 text-gray-600" },
  "stt-guard-dump": { label: "認識ガード（用語集羅列）", color: "bg-gray-100 text-gray-600" },
  "stt-guard-conf": { label: "認識ガード（自信度）", color: "bg-gray-100 text-gray-600" },
  "stt-guard-run": { label: "認識ガード（連番暴走）", color: "bg-gray-100 text-gray-600" },
};

function jst(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

export default function ErrorsPage() {
  const router = useRouter();
  const [errors, setErrors] = useState<AppErrorEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [guardVisible, setGuardVisible] = useState(true);

  const fetchErrors = async () => {
    setLoading(true);
    const res = await fetch("/api/admin/errors");
    if (res.ok) {
      const data = await res.json();
      setErrors(data.errors);
    }
    setLoading(false);
  };

  useEffect(() => { void fetchErrors(); }, []);

  const shown = guardVisible ? errors : errors.filter((e) => !e.type.startsWith("stt-guard"));

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">障害履歴</h1>
            <p className="text-sm text-gray-500 mt-1">
              通話中に起きた異常の記録（最新500件・通知が消えた後もここで確認できます）
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => router.push("/staff")}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
            >
              スタッフ画面へ
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={() => void fetchErrors()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-50 transition-colors"
          >
            <RefreshCw size={14} /> 最新の状態に更新
          </button>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 select-none">
            <input
              type="checkbox"
              checked={guardVisible}
              onChange={(e) => setGuardVisible(e.target.checked)}
            />
            認識ガードの作動記録も表示（幻聴対策が破棄したもの）
          </label>
          <span className="text-sm text-gray-400 ml-auto">{shown.length}件</span>
        </div>

        {/* List */}
        {loading ? (
          <p className="text-gray-500 text-sm py-8 text-center">読み込み中...</p>
        ) : shown.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-xl p-10 text-center text-gray-400">
            <AlertTriangle className="mx-auto mb-2" size={24} />
            記録された障害はありません
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-gray-500">
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">発生時刻（日本時間）</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">種類</th>
                  <th className="px-4 py-2.5 font-medium whitespace-nowrap">端末</th>
                  <th className="px-4 py-2.5 font-medium">内容</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => {
                  const t = TYPE_LABELS[e.type] ?? { label: e.type, color: "bg-gray-100 text-gray-600" };
                  return (
                    <tr key={`${e.at}-${i}`} className="border-t border-gray-100 align-top">
                      <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{jst(e.at)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${t.color}`}>{t.label}</span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 whitespace-nowrap">{e.machineName ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-700 break-all">{e.detail ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
