import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { getStations, saveStations } from "@/lib/stationClient";
import type { Station } from "@/lib/types";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const session = await verifySessionToken(token);
  return session?.isAdmin ? session : null;
}

interface ImportRow { name?: string; code?: string }

function normalize(row: Record<string, string>): ImportRow {
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k]?.toString().trim();
      if (v) return v;
    }
    return undefined;
  };
  return {
    name: get("駅名", "name", "NAME", "Name", "station", "STATION"),
    code: get("駅コード", "code", "CODE", "Code"),
  };
}

export async function POST(req: NextRequest) {
  if (!await requireAdmin(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { rows } = await req.json() as { rows: Record<string, string>[] };

  if (!rows || rows.length === 0) {
    return NextResponse.json({ added: 0, skipped: 0, warning: "データが見つかりませんでした。ファイルにデータが入力されているか確認してください。" });
  }

  // 列名が一致しない場合、最初の列を駅名・2列目を駅コードとして扱うフォールバック
  const firstRow = rows[0];
  const keys = Object.keys(firstRow);
  const nameKey = keys.find((k) => ["駅名","name","NAME","Name","station","STATION"].includes(k)) ?? keys[0];
  const codeKey = keys.find((k) => ["駅コード","code","CODE","Code"].includes(k)) ?? keys[1];

  const incoming = rows
    .map((row) => {
      const name = row[nameKey]?.toString().trim() || undefined;
      const code = codeKey ? row[codeKey]?.toString().trim() || undefined : undefined;
      return { name, code } as ImportRow;
    })
    .filter((r) => r.name && r.code);

  if (incoming.length === 0) {
    return NextResponse.json({ added: 0, skipped: 0, warning: `駅名の列が見つかりませんでした。1行目の列名が「駅名」になっているか確認してください（検出された列名：${keys.join("、")}）` });
  }

  const existing = await getStations();
  const existingNames = new Set(existing.map((s) => s.name));

  const newStations: Station[] = incoming
    .filter((r) => !existingNames.has(r.name!))
    .map((r) => ({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      name: r.name!,
      ...(r.code ? { code: r.code } : {}),
    }));

  await saveStations([...existing, ...newStations]);
  return NextResponse.json({ added: newStations.length, skipped: incoming.length - newStations.length });
}
