import type { LangCode } from "@/lib/socketEvents";

/**
 * 言語の国旗。
 *
 * ★絵文字（🇯🇵 等）は使わない。**Windows の標準の絵文字フォントには国旗が入っておらず、
 * 「JP」「US」のような2文字が表示されてしまう**（実機で確認済み・OS側では直せない）。
 * お客様が最初に触れる言語選択画面で手がかりが失われるため、画像に置き換えている。
 * 画像なのでどのOS・どのブラウザでも同じ見た目になる。
 */
export function Flag({ code, size = 20, className = "" }: { code: LangCode; size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/flags/${code}.svg`}
      alt=""
      aria-hidden="true"
      width={size}
      height={Math.round((size * 2) / 3)}
      className={`inline-block shrink-0 rounded-[2px] ${className}`}
      draggable={false}
    />
  );
}
