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

if (getApps().length === 0) {
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL ?? "";
  const rawKey = process.env.FIREBASE_PRIVATE_KEY ?? "";
  const privateKey = (rawKey.startsWith('"') ? rawKey.slice(1, -1) : rawKey).replace(/\\n/g, "\n");

  initializeApp({
    credential: new ServiceAccountCredential(clientEmail, privateKey),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

export const adminAuth = getAuth();
