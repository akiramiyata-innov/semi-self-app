"use client";

import { useEffect, useRef } from "react";

interface ScreenShareViewProps {
  frameData: string | null;
  label?: string;
  className?: string;
}

export function ScreenShareView({ frameData, label, className }: ScreenShareViewProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    if (imgRef.current && frameData) {
      imgRef.current.src = frameData;
    }
  }, [frameData]);

  if (!frameData) return null;

  return (
    <div className={`relative rounded-lg overflow-hidden bg-black ${className ?? ""}`}>
      {label && (
        <div className="absolute top-1 left-1 bg-black/60 text-white text-xs px-2 py-0.5 rounded z-10">
          {label}
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} alt={label ?? "共有画面"} className="w-full h-full object-contain" />
    </div>
  );
}
