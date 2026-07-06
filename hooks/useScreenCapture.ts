"use client";

import { useCallback, useRef, useState } from "react";

interface UseScreenCaptureOptions {
  fps?: number;
  quality?: number;
  width?: number;
  height?: number;
  onFrame?: (frameData: string) => void;
}

export function useScreenCapture({
  fps = 5,
  quality = 0.6,
  width = 640,
  height = 360,
  onFrame,
}: UseScreenCaptureOptions) {
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const onFrameRef = useRef(onFrame);
  const [capturing, setCapturing] = useState(false);

  // Keep onFrame ref fresh so the interval always uses the latest callback
  onFrameRef.current = onFrame;

  const stopCapture = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    setCapturing(false);
  }, []);

  const startCapture = useCallback(
    async (type: "display" | "camera" = "display", deviceId?: string) => {
      try {
        const stream =
          type === "display"
            ? await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: fps },
                audio: false,
              })
            : await navigator.mediaDevices.getUserMedia({
                video: deviceId ? { deviceId: { exact: deviceId } } : true,
                audio: false,
              });

        streamRef.current = stream;
        // Stop capture if the user stops sharing via browser UI
        stream.getVideoTracks()[0].addEventListener("ended", stopCapture);

        if (!canvasRef.current) {
          canvasRef.current = document.createElement("canvas");
        }
        canvasRef.current.width = width;
        canvasRef.current.height = height;

        const video = document.createElement("video");
        videoRef.current = video;
        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;

        // Wait for video to be ready — with a 3-second timeout fallback
        await Promise.race([
          new Promise<void>((resolve) => {
            video.onloadedmetadata = () => { video.play().catch(() => {}); resolve(); };
            video.oncanplay = () => resolve();
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);

        const ctx = canvasRef.current.getContext("2d");
        if (!ctx) return;

        setCapturing(true);
        intervalRef.current = setInterval(() => {
          if (!canvasRef.current || !videoRef.current) return;
          ctx.drawImage(videoRef.current, 0, 0, width, height);
          const frameData = canvasRef.current.toDataURL("image/jpeg", quality);
          onFrameRef.current?.(frameData);
        }, 1000 / fps);
      } catch (err) {
        console.error("Screen capture error:", err);
        setCapturing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fps, quality, width, height, stopCapture]
  );

  return { startCapture, stopCapture, capturing };
}
