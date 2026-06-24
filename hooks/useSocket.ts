"use client";

import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socketUrl = typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001");
    const s = io(socketUrl, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
    });

    s.on("connect", () => setConnected(true));
    s.on("disconnect", () => setConnected(false));
    socketRef.current = s;

    return () => {
      s.disconnect();
    };
  }, []);

  return { socket: socketRef.current, socketRef, connected };
}
