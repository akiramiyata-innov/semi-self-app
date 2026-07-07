"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, UserPlus, Upload, ChevronDown, ChevronUp, KeyRound, Shield, Building2 } from "lucide-react";
import * as XLSX from "xlsx";
import type { Station } from "@/lib/types";

interface StaffUser {
  uid: string;
  email: string;
  displayName: string;
  creationTime: string;
  isAdmin: boolean;
  isManager: boolean;
}

export default function AdminStaffPage() {
  const router = useRouter();
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [loading, setLoading] = useState(true);

  // 新規スタッフ追加
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({ displayName: "", email: "", password: "", isManager: false });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  // 担当駅パネル
  const [openAssignUid, setOpenAssignUid] = useState<string | null>(null);
  const [assignMap, setAssignMap] = useState<Record<string, string[]>>({});
  const [savingAssign, setSavingAssign] = useState(false);

  // PW変更パネル
  const [openPwUid, setOpenPwUid] = useState<string | null>(null);
  const [newPw, setNewPw] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const [pwError, setPwError] = useState("");

  // 一括インポート
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importResult, setImportResult] = useState<string | null>(null);

  const fetchAll = async () => {
    const [usersRes, stationsRes] = await Promise.all([
      fetch("/api/admin/users"),
      fetch("/api/admin/stations"),
    ]);
    if (usersRes.ok) setUsers((await usersRes.json()).users);
    if (stationsRes.ok) setStations((await stationsRes.json()).stations);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  // 担当駅を開く
  const openAssign = async (uid: string) => {
    if (openAssignUid === uid) { setOpenAssignUid(null); return; }
    if (!assignMap[uid]) {
      const res = await fetch(`/api/admin/staff/assignments/${uid}`);
      if (res.ok) {
        const data = await res.json();
        setAssignMap((prev) => ({ ...prev, [uid]: data.stationIds }));
      }
    }
    setOpenAssignUid(uid);
    setOpenPwUid(null);
  };

  const toggleStation = (uid: string, stationId: string) => {
    setAssignMap((prev) => {
      const current = prev[uid] ?? [];
      const next = current.includes(stationId)
        ? current.filter((id) => id !== stationId)
        : [...current, stationId];
      return { ...prev, [uid]: next };
    });
  };

  const saveAssign = async (uid: string) => {
    setSavingAssign(true);
    await fetch(`/api/admin/staff/assignments/${uid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stationIds: assignMap[uid] ?? [] }),
    });
    setSavingAssign(false);
    setOpenAssignUid(null);
  };

  // マネージャーフラグ切替
  const toggleManager = async (uid: string, current: boolean) => {
    await fetch(`/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isManager: !current }),
    });
    await fetchAll();
  };

  // スタッフ作成
  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true); setFormError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });
    if (res.ok) {
      setNewUser({ displayName: "", email: "", password: "", isManager: false });
      setShowForm(false);
      await fetchAll();
    } else {
      setFormError((await res.json()).error ?? "作成に失敗しました");
    }
    setCreating(false);
  };

  // スタッフ削除
  const deleteUser = async (uid: string, label: string) => {
    if (!confirm(`「${label}」を削除しますか？`)) return;
    await fetch(`/api/admin/users/${uid}`, { method: "DELETE" });
    await fetchAll();
  };

  // PW変更
  const openPw = (uid: string) => {
    if (openPwUid === uid) { setOpenPwUid(null); return; }
    setNewPw(""); setPwError("");
    setOpenPwUid(uid);
    setOpenAssignUid(null);
  };

  const savePw = async (uid: string) => {
    if (newPw.length < 8) { setPwError("8文字以上で入力してください"); return; }
    setSavingPw(true); setPwError("");
    // Admin changing another staff's password via admin SDK
    const res = await fetch(`/api/admin/users/${uid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: newPw }),
    });
    if (res.ok) { setOpenPwUid(null); setNewPw(""); }
    else setPwError((await res.json()).error ?? "変更に失敗しました");
    setSavingPw(false);
  };

  // 一括インポート
  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setImportResult(null);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      // raw: false → 数値・日付セルも整形済み文字列で返す（サーバー側の .trim() が number で落ちるのを防ぐ）
      const rows = XLSX.utils.sheet_to_json<Record<string, string>>(ws, { defval: "", raw: false });
      const res = await fetch("/api/admin/users/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      const results = (data.results as { status: string; email: string; reason?: string }[]) ?? [];
      const errors = results.filter((r) => r.status === "error");
      const skipped = results.filter((r) => r.status === "skipped");
      const parts = [`${data.created}件作成完了`];
      if (errors.length > 0) {
        const reasons = errors.map((r) => `${r.email}：${r.reason ?? "不明"}`).join("、");
        parts.push(`${errors.length}件エラー（${reasons}）`);
      }
      if (skipped.length > 0) parts.push(`${skipped.length}件スキップ（必須項目不足）`);
      setImportResult(parts.join(" / "));
      await fetchAll();
    } catch {
      setImportResult("インポートに失敗しました");
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/staff/login");
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">スタッフ管理</h1>
            <p className="text-sm text-gray-500 mt-1">アカウント・担当駅・権限を管理します</p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            <button onClick={() => router.push("/admin/stations")} className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100">
              駅マスター
            </button>
            <button onClick={() => router.push("/admin/glossary")} className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100">
              用語集
            </button>
            <button onClick={() => router.push("/staff")} className="px-3 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-100">
              スタッフ画面
            </button>
            <button onClick={handleLogout} className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
              ログアウト
            </button>
          </div>
        </div>

        {/* インポートバー */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-700">Excel / CSV 一括登録</p>
            <p className="text-xs text-gray-400 mt-0.5">列名: 名前・メール・パスワード・マネージャー（○/true）</p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/スタッフ登録テンプレート.xlsx"
              download
              className="flex items-center gap-1.5 px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded-lg hover:bg-gray-200 border border-gray-300"
            >
              テンプレート
            </a>
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700">
              <Upload size={14} />インポート
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
        </div>
        {importResult && <p className="text-sm text-blue-600 mb-3 px-1">{importResult}</p>}

        {/* スタッフ一覧 */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">スタッフが登録されていません</div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {users.map((user) => (
                <li key={user.uid}>
                  {/* メイン行 */}
                  <div className="flex items-center justify-between px-5 py-3.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {user.displayName || "（名前未設定）"}
                          </p>
                          {user.isAdmin && (
                            <span className="shrink-0 px-1.5 py-0.5 bg-blue-100 text-blue-700 text-xs rounded-full">管理者</span>
                          )}
                          {user.isManager && (
                            <span className="shrink-0 px-1.5 py-0.5 bg-purple-100 text-purple-700 text-xs rounded-full">マネージャー</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">{user.email}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-2">
                      {/* マネージャーフラグ */}
                      {!user.isAdmin && (
                        <button
                          onClick={() => toggleManager(user.uid, user.isManager)}
                          title={user.isManager ? "マネージャー解除" : "マネージャーに設定"}
                          className={`p-2 rounded-lg transition-colors ${user.isManager ? "text-purple-600 bg-purple-50 hover:bg-purple-100" : "text-gray-400 hover:text-purple-500 hover:bg-purple-50"}`}
                        >
                          <Shield size={15} />
                        </button>
                      )}
                      {/* 担当駅 */}
                      <button
                        onClick={() => openAssign(user.uid)}
                        title="担当駅を設定"
                        className={`p-2 rounded-lg transition-colors ${openAssignUid === user.uid ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-blue-500 hover:bg-blue-50"}`}
                      >
                        <Building2 size={15} />
                      </button>
                      {/* PW変更 */}
                      <button
                        onClick={() => openPw(user.uid)}
                        title="パスワード変更"
                        className={`p-2 rounded-lg transition-colors ${openPwUid === user.uid ? "text-amber-600 bg-amber-50" : "text-gray-400 hover:text-amber-500 hover:bg-amber-50"}`}
                      >
                        <KeyRound size={15} />
                      </button>
                      {/* 削除 */}
                      {!user.isAdmin && (
                        <button
                          onClick={() => deleteUser(user.uid, user.displayName || user.email)}
                          className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 担当駅パネル */}
                  {openAssignUid === user.uid && (
                    <div className="px-5 pb-4 bg-blue-50 border-t border-blue-100">
                      <p className="text-xs font-semibold text-blue-700 mt-3 mb-2">担当駅を選択</p>
                      {stations.length === 0 ? (
                        <p className="text-xs text-gray-400">
                          駅が登録されていません。
                          <button onClick={() => router.push("/admin/stations")} className="text-blue-500 underline ml-1">駅マスターへ</button>
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 gap-1.5 mb-3">
                          {stations.map((s) => {
                            const checked = (assignMap[user.uid] ?? []).includes(s.id);
                            return (
                              <label key={s.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleStation(user.uid, s.id)}
                                  className="w-4 h-4 accent-blue-600"
                                />
                                <span>{s.name}{s.code ? ` (${s.code})` : ""}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveAssign(user.uid)}
                          disabled={savingAssign}
                          className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {savingAssign ? "保存中..." : "保存"}
                        </button>
                        <button onClick={() => setOpenAssignUid(null)} className="px-3 py-1.5 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white">
                          キャンセル
                        </button>
                      </div>
                    </div>
                  )}

                  {/* PW変更パネル */}
                  {openPwUid === user.uid && (
                    <div className="px-5 pb-4 bg-amber-50 border-t border-amber-100">
                      <p className="text-xs font-semibold text-amber-700 mt-3 mb-2">
                        {user.displayName || user.email} のパスワードを変更
                      </p>
                      <div className="flex gap-2 items-start">
                        <input
                          type="text"
                          value={newPw}
                          onChange={(e) => setNewPw(e.target.value)}
                          placeholder="新しいパスワード（8文字以上）"
                          className="flex-1 px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
                          minLength={8}
                        />
                        <button
                          onClick={() => savePw(user.uid)}
                          disabled={savingPw}
                          className="px-3 py-1.5 bg-amber-500 text-white text-xs rounded-lg hover:bg-amber-600 disabled:opacity-50 shrink-0"
                        >
                          {savingPw ? "変更中..." : "変更"}
                        </button>
                        <button onClick={() => setOpenPwUid(null)} className="px-3 py-1.5 text-gray-500 border border-gray-300 text-xs rounded-lg hover:bg-white shrink-0">
                          取消
                        </button>
                      </div>
                      {pwError && <p className="text-red-500 text-xs mt-1">{pwError}</p>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* スタッフ追加フォーム */}
        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700"
          >
            <UserPlus size={16} />スタッフを追加
          </button>
        ) : (
          <form onSubmit={createUser} className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
            <h2 className="text-base font-semibold text-gray-900 mb-4">新規スタッフ追加</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">名前</label>
                <input
                  type="text"
                  value={newUser.displayName}
                  onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                  placeholder="例：山田 太郎"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  placeholder="例：yamada@example.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">仮パスワード</label>
                <input
                  type="text"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  placeholder="8文字以上"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required minLength={8}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newUser.isManager}
                  onChange={(e) => setNewUser({ ...newUser, isManager: e.target.checked })}
                  className="w-4 h-4 accent-purple-600"
                />
                マネージャー権限を付与
              </label>
            </div>
            {formError && <p className="text-red-500 text-sm mt-3">{formError}</p>}
            <div className="flex gap-2 mt-4">
              <button type="submit" disabled={creating} className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {creating ? "追加中..." : "追加する"}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setFormError(""); }} className="px-4 py-2 text-gray-600 border border-gray-300 text-sm rounded-lg hover:bg-gray-50">
                キャンセル
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
