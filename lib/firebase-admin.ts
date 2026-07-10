import { initializeApp, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { Credential, GoogleOAuthAccessToken } from "firebase-admin/app";
import { SignJWT, importPKCS8 } from "jose";

class ServiceAccountCredential implements Credential {
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientEmail: string,
    private readonly privateKeyPem: string
  ) {}

  async getAccessToken(): Promise<GoogleOAuthAccessToken> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60) {
      return {
        access_token: this.cachedToken.token,
        expires_in: this.cachedToken.expiresAt - now,
      };
    }

    const privateKey = await importPKCS8(this.privateKeyPem, "RS256");

    const jwt = await new SignJWT({
      scope: [
        "https://www.googleapis.com/auth/cloud-platform",
        "https://www.googleapis.com/auth/firebase",
      ].join(" "),
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.clientEmail)
      .setSubject(this.clientEmail)
      .setAudience("https://oauth2.googleapis.com/token")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`OAuth2 token fetch failed: ${JSON.stringify(err)}`);
    }

    const data = await res.json();
    this.cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
    return { access_token: data.access_token, expires_in: data.expires_in };
  }
}

// FIREBASE_PRIVATE_KEY を、どの保存形式でも確実にPEMへ正規化する。
// 対応: 前後クォート付き / \n・\r\n エスケープ / 実改行 / base64エンコード。
// （Railway等では貼り付け時に改行やクォートの扱いがずれて鍵が壊れることがあるため、
//   base64で渡せばエスケープ事故を完全に回避できる。）
function loadPrivateKey(raw: string): string {
  let k = (raw ?? "").trim();
  if (k.length >= 2 && ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'")))) {
    k = k.slice(1, -1);
  }
  if (!k.includes("BEGIN")) {
    try {
      const decoded = Buffer.from(k, "base64").toString("utf8");
      if (decoded.includes("BEGIN")) k = decoded;
    } catch { /* base64ではない → そのまま */ }
  }
  return k.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

if (getApps().length === 0) {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const privateKey = loadPrivateKey(process.env.FIREBASE_PRIVATE_KEY ?? "");

  initializeApp({
    credential: new ServiceAccountCredential(clientEmail, privateKey),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

export const adminAuth = getAuth();
