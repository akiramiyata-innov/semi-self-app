"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, BookPlus, Upload, Pencil } from "lucide-react";
import * as XLSX from "xlsx";
import type { GlossaryTerm } from "@/lib/types";

const LANG_LABELS: { key: keyof GlossaryTerm; label: string }[] = [
  { key: "en", label: "英語" },
  { key: "zh", label: "中国語（簡体）" },
  { key: "zh-TW", label: "中国語（繁体）" },
  { key: "ko", label: "韓国語" },
  { key: "fr", label: "仏語" },
  { key: "es", label: "西語" },
  { key: "th", label: "タイ語" },
];

const EMPTY_FORM = { ja: "", yomi: "", en: "", zh: "", "zh-TW": "", ko: "", fr: "", es: "", th: "" };

export default function GlossaryPage() {
  const router = useRouter();
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ text: string; ok: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 編集中の用語の id（null なら新規追加）。同じ入力欄を追加と編集で使い回す（v1.54.0）。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const fetchTerms = async () => {
    const res = await fetch("/api/admin/glossary");
    if (res.ok) {
      const data = await res.json();
      setTerms(data.terms);
    }
    setLoading(false);
  };

  useEffect(() => { fetchTerms(); }, []);

  /** 追加（POST）と編集（PUT）を同じ入力欄から送る。 */
  const submitTerm = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError("");
    const res = await fetch(editingId ? `/api/admin/glossary/${editingId}` : "/api/admin/glossary", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.ok) {
      setForm(EMPTY_FORM);
      setShowForm(false);
      setEditingId(null);
      await fetchTerms();
    } else {
      const data = await res.json();
      setFormError(data.error ?? (editingId ? "更新に失敗しました" : "追加に失敗しました"));
    }
    setSaving(false);
  };

  /** 既存の用語を入力欄に読み込んで編集モードにする（v1.54.0）。 */
  const startEdit = (term: GlossaryTerm) => {
    setEditingId(term.id);
    setForm({
      ja: term.ja, yomi: term.yomi ?? "", en: term.en ?? "", zh: term.zh ?? "", "zh-TW": term["zh-TW"] ?? "",
      ko: term.ko ?? "", fr: term.fr ?? "", es: term.es ?? "", th: term.th ?? "",
    });
    setFormError("");
    setShowForm(true);
    // 入力欄は一覧の下にあるので、見える位置まで送る
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

  const cancelForm = () => {
    setShowForm(false);
    setFormError("");
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const deleteTerm = async (id: string, label: string) => {
    if (!confirm(`「${label}」を削除しますか？`)) return;
    await fetch(`/api/admin/glossary/${id}`, { method: "DELETE" });
    await fetchTerms();
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // raw: false → 数値・日付セルも整形済み文字列で返す（後段の .trim() が number で落ちるのを防ぐ）
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "", raw: false });

      const terms = rows.map((row) => {
        const normalize = (keys: string[]) =>
          keys.map((k) => row[k] ?? "").find((v) => v.trim()) ?? "";
        return {
          ja: normalize(["日本語", "ja", "JA", "Japanese"]),
          yomi: normalize(["よみ", "読み", "ふりがな", "yomi", "reading"]),
          en: normalize(["英語", "en", "EN", "English"]),
          zh: normalize(["中国語（簡体）", "中国語", "zh", "ZH", "Chinese", "Simplified Chinese"]),
          "zh-TW": normalize(["中国語（繁体）", "繁体字中国語", "zh-TW", "ZH-TW", "Traditional Chinese", "繁体中文"]),
          ko: normalize(["韓国語", "ko", "KO", "Korean"]),
          fr: normalize(["フランス語", "fr", "FR", "French"]),
          es: normalize(["スペイン語", "es", "ES", "Spanish"]),
          th: normalize(["タイ語", "th", "TH", "Thai"]),
        };
      }).filter((r) => r.ja.trim());

      if (terms.length === 0) {
        setImportResult({ text: "読み込める用語がありませんでした。1列目が「日本語」または「ja」になっているか確認してください。", ok: false });
        setImporting(false);
        return;
      }

      const res = await fetch("/api/admin/glossary/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terms }),
      });
      const data = await res.json();
      if (res.ok) {
        const notes: string[] = [];
        if (data.duplicated) notes.push(`${data.duplicated}件は既に登録済みのためスキップ`);
        // よみは必須なので、未入力の行は登録されない。どの語かを示して直せるようにする。
        if (data.noYomi) {
          const samples = (data.noYomiSamples ?? []).join("、");
          notes.push(`${data.noYomi}件はよみが未入力のため登録できません（${samples}${data.noYomi > (data.noYomiSamples?.length ?? 0) ? " ほか" : ""}）`);
        }
        setImportResult({
          text: `${data.added}件追加しました${notes.length ? `／${notes.join("／")}` : ""}`,
          ok: !data.noYomi,
        });
        await fetchTerms();
      } else {
        setImportResult({ text: data.error ?? "インポートに失敗しました", ok: false });
      }
    } catch {
      setImportResult({ text: "ファイルの読み込みに失敗しました", ok: false });
    }
    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/staff/login");
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">用語集管理</h1>
            <p className="text-sm text-gray-500 mt-1">
              STT認識・翻訳に使用する専門用語を登録します
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => router.push("/staff")}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100 transition-colors"
            >
              スタッフ画面へ
            </button>
            <button
              onClick={handleLogout}
              className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 transition-colors"
            >
              ログアウト
            </button>
          </div>
        </div>

        {/* Term list */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : terms.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              用語が登録されていません
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-600 whitespace-nowrap">日本語</th>
                  <th className="text-left px-3 py-3 font-medium text-gray-600 whitespace-nowrap">よみ</th>
                  {LANG_LABELS.map((l) => (
                    <th key={l.key} className="text-left px-3 py-3 font-medium text-gray-600">{l.label}</th>
                  ))}
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {terms.map((term) => (
                  <tr key={term.id} className={term.id === editingId ? "bg-blue-50" : "hover:bg-gray-50"}>
                    <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">{term.ja}</td>
                    <td className="px-3 py-3 text-gray-500 whitespace-nowrap">
                      {term.yomi || <span className="text-gray-300">—</span>}
                    </td>
                    {LANG_LABELS.map((l) => (
                      <td key={l.key} className="px-3 py-3 text-gray-500">
                        {term[l.key] || <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                    <td className="px-3 py-3 whitespace-nowrap">
                      <button
                        onClick={() => startEdit(term)}
                        className="p-1.5 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
                        title="編集"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => deleteTerm(term.id, term.ja)}
                        className="p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="削除"
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Buttons row */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              <BookPlus size={16} />
              用語を追加
            </button>
          )}
          <a
            href="/用語集登録テンプレート.xlsx"
            download
            className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors"
          >
            テンプレート
          </a>
          <label className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors cursor-pointer ${importing ? "opacity-50 pointer-events-none" : "text-gray-700 border-gray-300 hover:bg-gray-50"}`}>
            <Upload size={16} />
            {importing ? "インポート中..." : "Excel / CSV で一括登録"}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleImport}
            />
          </label>
        </div>

        {importResult && (
          <div className={`mb-4 px-4 py-2.5 rounded-lg text-sm ${importResult.ok ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
            {importResult.text}
          </div>
        )}

        {showForm && (
          <form
            ref={formRef}
            onSubmit={submitTerm}
            className={`bg-white rounded-xl shadow-sm border p-5 ${editingId ? "border-blue-300 ring-2 ring-blue-100" : "border-gray-200"}`}
          >
            <h2 className="text-base font-semibold text-gray-900 mb-4">
              {editingId
                ? <>用語を編集：「{terms.find((t) => t.id === editingId)?.ja ?? ""}」<span className="ml-2 text-xs font-normal text-gray-500">保存すると、翻訳と音声認識にすぐ反映されます</span></>
                : "新規用語追加"}
            </h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  日本語 <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={form.ja}
                  onChange={(e) => setForm({ ...form, ja: e.target.value })}
                  placeholder="例：定期券"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required
                  autoFocus
                />
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  よみ（ひらがな） <span className="text-red-500">*</span>{" "}
                  <span className="text-gray-400 font-normal">認識した文字を登録どおりの表記に直すために使います</span>
                </label>
                <input
                  type="text"
                  value={form.yomi}
                  onChange={(e) => setForm({ ...form, yomi: e.target.value })}
                  placeholder="例：とねり（舎人）、ひもんや（碑文谷）"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required
                />
              </div>
              {LANG_LABELS.map((l) => (
                <div key={l.key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{l.label}</label>
                  <input
                    type="text"
                    value={form[l.key as keyof typeof form]}
                    onChange={(e) => setForm({ ...form, [l.key]: e.target.value })}
                    placeholder={l.key === "en" ? "commuter pass" : ""}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              ))}
            </div>

            {formError && <p className="text-red-500 text-sm mt-3">{formError}</p>}

            <div className="flex gap-2 mt-4">
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {editingId ? (saving ? "保存中..." : "保存する") : (saving ? "追加中..." : "追加する")}
              </button>
              <button
                type="button"
                onClick={cancelForm}
                className="px-4 py-2 text-gray-600 border border-gray-300 text-sm rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
