interface KioskHeaderProps {
  /** 路線名（例: 浅草線）。未指定なら非表示。 */
  line?: string;
  /** 駅名（例: 新橋駅）。未指定なら非表示。 */
  stationName?: string;
  /** 駅ナンバリング（例: A10）。先頭の英字と数字に分けて丸バッジに表示する。 */
  stationCode?: string;
}

/** "A10" → { letter: "A", number: "10" } */
function splitStationCode(code: string) {
  const m = code.trim().match(/^([A-Za-z]*)\s*(\d*)$/);
  if (!m) return { letter: code.trim(), number: "" };
  return { letter: m[1], number: m[2] };
}

/**
 * 都営地下鉄ロゴの仮デザイン。正式なロゴ画像を入手したら
 * この <svg> を <img src="/toei-logo.svg" ... /> に差し替える。
 */
function ToeiLogoPlaceholder() {
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 64 64" className="w-12 h-12 shrink-0" aria-hidden="true">
        <path
          d="M32 6c-9 8-16 15-16 25a16 16 0 0 0 32 0c0-10-7-17-16-25z"
          fill="#00913a"
        />
      </svg>
      <div className="leading-none">
        <div className="text-3xl font-bold tracking-[0.25em] text-gray-900">
          都営地下鉄
        </div>
        <div className="mt-1 text-xs font-semibold tracking-[0.2em] text-gray-400">
          TOEI SUBWAY
        </div>
      </div>
    </div>
  );
}

export function KioskHeader({ line, stationName, stationCode }: KioskHeaderProps) {
  const code = stationCode ? splitStationCode(stationCode) : null;
  const hasStationInfo = Boolean(code || line || stationName);

  return (
    <header className="shrink-0 min-h-24 flex items-center justify-between bg-white px-10 py-4 shadow-[0_2px_6px_rgba(0,0,0,0.18)]">
      <ToeiLogoPlaceholder />

      {hasStationInfo && (
        <div className="flex items-center gap-4">
          {code && (
            <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-full border-[3px] border-[#e8462d] leading-none">
              <span className="text-sm font-bold text-gray-900">{code.letter}</span>
              <span className="text-lg font-bold text-gray-900">{code.number}</span>
            </div>
          )}
          <div className="text-3xl font-bold text-gray-900">
            {line}
            {line && stationName && <span className="inline-block w-6" />}
            {stationName}
          </div>
        </div>
      )}
    </header>
  );
}
