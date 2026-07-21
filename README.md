# semi-self-app — 駅係員 遠隔接客アプリ（POC）

鉄道駅の券売機・精算機に設置する端末（キオスク）から、遠隔地の駅係員をリアルタイムに呼び出して接客するWebアプリです。**券売機に組み込む実機開発の前段階として作られた概念実証（POC）**で、Railway 上で本番相当の環境が稼働しています。

お客様の発話は音声認識され、係員の日本語は自動翻訳・音声合成されて、キオスク画面のアバターが話します（8言語対応）。

---

## 主な機能

| 機能 | 概要 |
|---|---|
| リアルタイム通話 | Socket.IO によるキオスク⇔係員の双方向通信（呼び出し・応答・切断検知） |
| 音声認識（STT） | Google Cloud Speech-to-Text V2（chirp_2）＋用語集による専門用語の辞書補正 |
| 自動翻訳 | Google Cloud Translation v2。用語集で訳語を固定可能 |
| 音声合成（TTS） | Google Cloud Text-to-Speech（Chirp3-HD）。長文は自動分割して合成 |
| アバター | SVG＋音量連動の口パク。係員の音声に合わせて発話 |
| カメラ | キオスクの正面／手元カメラ映像を係員へ配信（着信中のプレビュー含む） |
| 画面共有 | 係員の画面をキオスクへ配信 |
| 認証・権限 | Firebase Authentication ＋ JWTセッション。管理者/一般スタッフの権限分離 |
| 管理機能 | スタッフ管理・駅マスタ管理・用語集管理（Excel一括登録対応） |
| 通話ログ | 会話全文を Google Cloud Storage に保存、`/logs` で閲覧 |

---

## 技術スタック

- **Next.js 16**（App Router）/ React 19 / TypeScript 5 / Tailwind CSS v4
- **Socket.IO 4.8** — カスタムサーバー `server.ts` で Next.js と同一プロセス起動
- **Google Cloud** — Speech-to-Text V2 / Text-to-Speech / Translation / Cloud Storage
- **Firebase** — Authentication（メール＋パスワード）、Admin SDK
- **その他** — Zustand（状態管理）、kuromoji（形態素解析）、xlsx、jose（JWT）
- **ホスティング** — Railway（`main` ブランチへの push で自動デプロイ）

> 詳しい構成と認証情報の対応表は `Dropbox/234_セミセルフ窓処開発/20_Document/遠隔接客アプリ_使用技術・APIキー一覧.docx` を参照。

---

## ローカルでの起動

### 前提
- Node.js 22 系
- `.env.local`（APIキー等）— **リポジトリには含まれていません。** 管理者から安全な方法で受け取ってください

### 手順

```bash
npm install
npm run dev
```

**ポートは 3001 です**（3000 は別アプリが使用中のため固定）。

- キオスク画面：http://localhost:3001/user?machine=kiosk-1&name=券売機1番
- 係員画面：http://localhost:3001/staff （要ログイン）

> `npm run dev` は `next dev` ではなく **`tsx server.ts`** を実行します（Socket.IO を同居させるため）。
> **`server/` 配下や `lib/` を変更した場合はサーバーの再起動が必要です**（Next.js 側の画面は HMR で反映されます）。

### 動作確認の手順
1. タブAで係員画面を開きログイン
2. タブBでキオスク画面を開く → 言語を選択 →「係員を呼ぶ」
3. 係員画面で「応答」→ 双方向で会話（マイク／テキスト／定型文）

> 1台のPCで試す場合、キオスク側の音声をマイクが拾ってエコーになるため、キオスクのタブはミュート推奨です（本番は別拠点のため発生しません）。

---

## 環境変数

| 変数 | 用途 |
|---|---|
| `GOOGLE_API_KEY` | TTS・翻訳・旧STT（V1）で使用 |
| `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` / `FIREBASE_PROJECT_ID` | Firebase Admin。**STT V2（chirp_2）の認証にも使用** |
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` / `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | クライアント側 Firebase 認証（ビルド時に埋め込まれる） |
| `SESSION_SECRET` | セッションJWTの署名 |
| `GOOGLE_STORAGE_BUCKET` / `GOOGLE_APPLICATION_CREDENTIALS_JSON` | 通話ログ・用語集等の保存先（GCS） |
| `FIREBASE_ADMIN_EMAILS` | 固定管理者（締め出し防止の非常用） |
| `NEXT_PUBLIC_STT_MODE` | `streaming` で新音声認識を有効化（未設定なら旧方式） |
| `PORT` | 既定 3001 |

---

## ディレクトリ構成（主要ファイル）

```
server.ts                    起動エントリ（.env.local読込 → Next + Socket.IO）
proxy.ts                     /staff・/admin・/logs の認証ゲート
server/
  socketServer.ts            ★中核。通話制御・翻訳・TTS・ログ保存・認証
  sttStream.ts               ストリーミング音声認識（V2 chirp_2＋辞書）
app/
  user/UserScreen.tsx        キオスク画面
  staff/page.tsx             係員画面
  api/                       認証・管理・ログ・STT の各API
components/
  Avatar.tsx                 アバター（音声再生・口パク）
  ActiveCallPanel.tsx        通話中パネル（定型文・テキスト送信）
hooks/
  useSpeechRecognition.ts    音声認識（streaming / Chrome / Edge の3経路）
lib/
  session.ts                 JWTセッション
  jsonStore.ts               GCS＋ローカル＋TTLキャッシュの汎用ストア
  speechClient.ts            Speech V2 クライアント
  languages.ts               対応言語・音声設定
```

---

## 設計上の注意点（レビュー時の前提）

- **音声認識は3経路あります**：`streaming`（V2・現行）／Chrome内蔵（Web Speech API）／Edge向け同期STT。`NEXT_PUBLIC_STT_MODE` で切り替わります。
- **Speech V2 は APIキーが使えません**（Google側の仕様）。そのためサービスアカウント認証を使い、Speech APIが有効な別GCPプロジェクトのリソースを参照しています（`lib/speechClient.ts`）。
- **Socket.IO サーバーと Next.js API ルートは別モジュールインスタンス**です。キャッシュが共有されないため、通話サーバー側は `*Fresh()`（キャッシュ非経由）で最新を読みます。
- **Socket通信には認証があります**（v1.16.0〜）。ログインCookieを検証し、係員側イベントは認証済み接続のみ受理します。キオスク側は匿名のままです。
- **TTSは一文の長さに制限**があり、句読点のない長文は自動分割して合成・連結しています（`splitForTts`）。

---

## 既知の課題（対応済みでないもの）

- 音声認識API（`/api/stt`・Socketの`stt:*`）に**レート制限がない**（キオスクが公開ページのため、悪用時のコスト増リスク）
- 通話ログ一覧はGCSの全ファイルを毎回読むため、**件数が増えると遅くなる**
- 翻訳の用語固定に内部プレースホルダを使用しており、翻訳エンジンが変形させる可能性が理論上残る

---

## バージョン履歴

`CHANGELOG.md` を参照してください（最新は v1.16.0）。

## デプロイ

`main` ブランチへ push すると Railway が自動デプロイします。バージョンを上げる際は `package.json` の更新と注釈付きgitタグ（`vX.Y.Z`）を併せて作成しています。
