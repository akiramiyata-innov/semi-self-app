"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Plus, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import type { Station } from "@/lib/types";

export default function AdminStationsPage() {
  const router = useRouter();
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [adding, setAdding] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchStations = async () => {
    const res = await fetch("/api/admin/stations");
    if (res.ok) {
      const data = await res.json();
      setStations(data.stations);
    }
    setLoading(false);
  };

  useEffect(() => { fetchStations(); }, []);

  const addStation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    await fetch("/api/admin/stations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), code: code.trim() }),
    });
    setName(""); setCode("");
    await fetchStations();
    setAdding(false);
  };

  const deleteStation = async (id: string, label: string) => {
    if (!confirm(`「${label}」を削除しますか？`)) return;
    await fetch(`/api/admin/stations/${id}`, { method: "DELETE" });
    await fetchStations();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportResult(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "" });
      const res = await fetch("/api/admin/stations/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      setImportResult(`${data.added}件追加、${data.skipped}件スキップ`);
      await fetchStations();
    } catch {
      setImportResult("インポートに失敗しました");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">駅マスター管理</h1>
            <p className="text-sm text-gray-500 mt-1">担当駅の選択肢を管理します</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push("/admin/staff")} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100">
              スタッフ管理へ
            </button>
            <button onClick={() => router.push("/staff")} className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100">
              スタッフ画面へ
            </button>
          </div>
        </div>

        {/* Import */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-gray-700">Excel / CSV 一括インポート</p>
              <p className="text-xs text-gray-400 mt-0.5">列名: 駅名（必須）、駅コード（任意）</p>
            </div>
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700">
              <Upload size={14} />インポート
            </button>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
          </div>
          {importResult && <p className="text-sm text-blue-600 mt-2">{importResult}</p>}
        </div>

        {/* Station list */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : stations.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">駅が登録されていません</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {stations.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{s.name}</p>
                    {s.code && <p className="text-xs text-gray-400">{s.code}</p>}
                  </div>
                  <button onClick={() => deleteStation(s.id, s.name)} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add form */}
        <form onSubmit={addStation} className="bg-white rounded-xl shadow-sm border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-800 mb-3">駅を追加</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="駅名（例：新宿駅）"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              required
            />
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="駅コード（任意）"
              className="w-36 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <button type="submit" disabled={adding} className="flex items-center gap-1 px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
              <Plus size={14} />追加
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
