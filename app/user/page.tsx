import { Suspense } from "react";
import { UserScreen } from "./UserScreen";

interface PageProps {
  searchParams: Promise<{
    machine?: string;
    name?: string;
    station?: string;
    line?: string;
    stationName?: string;
    code?: string;
  }>;
}

export default async function UserPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const machineId = params.machine ?? "kiosk-1";
  const machineName = params.name ?? "券売機1番";
  const stationId = params.station ?? "";

  return (
    <Suspense fallback={<div className="min-h-screen bg-blue-900 flex items-center justify-center text-white">読み込み中...</div>}>
      <UserScreen
        machineId={machineId}
        machineName={machineName}
        stationId={stationId}
        line={params.line}
        stationName={params.stationName}
        stationCode={params.code}
      />
    </Suspense>
  );
}
