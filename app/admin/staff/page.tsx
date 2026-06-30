"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, UserPlus } from "lucide-react";

interface FirebaseUser {
  uid: string;
  email: string;
  displayName: string;
  creationTime: string;
}

export default function AdminStaffPage() {
  const router = useRouter();
  const [users, setUsers] = useState<FirebaseUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newUser, setNewUser] = useState({ displayName: "", email: "", password: "" });
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState("");

  const fetchUsers = async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
    }
    setLoading(false);
  };

  useEffect(() => { fetchUsers(); }, []);

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormError("");

    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newUser),
    });

    if (res.ok) {
      setNewUser({ displayName: "", email: "", password: "" });
      setShowForm(false);
      await fetchUsers();
    } else {
      const data = await res.json();
      setFormError(data.error ?? "作成に失敗しました");
    }
    setCreating(false);
  };

  const deleteUser = async (uid: string, label: string) => {
    if (!confirm(`「${label}」を削除しますか？\nこの操作は取り消せません。`)) return;
    await fetch(`/api/admin/users/${uid}`, { method: "DELETE" });
    await fetchUsers();
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
            <p className="text-sm text-gray-500 mt-1">
              スタッフアカウントの追加・削除ができます
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

        {/* User list */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 mb-4">
          {loading ? (
            <div className="p-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              スタッフが登録されていません
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {users.map((user) => (
                <li
                  key={user.uid}
                  className="flex items-center justify-between px-5 py-3.5"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {user.displayName || "（名前未設定）"}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{user.email}</p>
                  </div>
                  <button
                    onClick={() => deleteUser(user.uid, user.displayName || user.email)}
                    className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    title="削除"
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add user */}
        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <UserPlus size={16} />
            スタッフを追加
          </button>
        ) : (
          <form
            onSubmit={createUser}
            className="bg-white rounded-xl shadow-sm border border-gray-200 p-5"
          >
            <h2 className="text-base font-semibold text-gray-900 mb-4">
              新規スタッフ追加
            </h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  名前
                </label>
                <input
                  type="text"
                  value={newUser.displayName}
                  onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
                  placeholder="例：山田 太郎"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  メールアドレス
                </label>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  仮パスワード
                </label>
                <input
                  type="text"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  placeholder="8文字以上"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                  required
                  minLength={8}
                />
              </div>
            </div>

            {formError && (
              <p className="text-red-500 text-sm mt-3">{formError}</p>
            )}

            <div className="flex gap-2 mt-4">
              <button
                type="submit"
                disabled={creating}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {creating ? "追加中..." : "追加する"}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError(""); }}
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
