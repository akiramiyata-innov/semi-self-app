"use client";

export interface ToastItem {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

interface ToastProps {
  toasts: ToastItem[];
}

export function Toast({ toasts }: ToastProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`px-4 py-3 rounded-xl shadow-lg text-white text-sm font-medium max-w-xs ${
            t.type === "warning"
              ? "bg-amber-500"
              : t.type === "error"
              ? "bg-red-500"
              : "bg-gray-800"
          }`}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
