// Load .env.local BEFORE any other imports so socketServer.ts picks up env vars
import { readFileSync } from "fs";
import { resolve } from "path";
try {
  const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env.local not found — ignore */ }

import { createServer } from "http";
import next from "next";
import { initSocketServer } from "./server/socketServer";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, hostname: "localhost", port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  // Primary server: Next.js + Socket.IO (port 3001)
  const httpServer = createServer((req, res) => {
    handle(req, res);
  });

  initSocketServer(httpServer);

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });

});
