# 自動テスト チェックリスト（A: テストコード自動生成・実行）

**対象バージョン**: v0.6.0  
**テストフレームワーク**: Jest  
**実行コマンド**: `npm test` または `npm test -- --verbose`

---

## テスト層別リスト

### 層1: API Route Handler テスト （20項目）

#### 1.1 POST /api/translate/route.ts

| # | テスト項目 | 入力 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 1-1 | 正常なリクエスト（日→英） | text: "こんにちは", from: "ja", to: "en" | status: 200, translatedText: "Hello" | ステータス 200 かつ text !== translatedText |
| 1-2 | 正常なリクエスト（英→日） | text: "Hello", from: "en", to: "ja" | status: 200, translatedText: "こんにちは" | ステータス 200 かつ日本語を含む |
| 1-3 | キャッシュヒット（同一テキスト2回） | 1回目と2回目で同じテキスト | キャッシュから即座に返す | 2回目の実行時間 < 10ms |
| 1-4 | 無効な言語コード（from） | text: "test", from: "xx", to: "en" | status: 400, error message | ステータス 400 かつ error フィールド存在 |
| 1-5 | 無効な言語コード（to） | text: "test", from: "en", to: "yy" | status: 400, error message | ステータス 400 |
| 1-6 | 空のテキスト | text: "", from: "ja", to: "en" | status: 400 | ステータス 400 |
| 1-7 | null テキスト | text: null, from: "ja", to: "en" | status: 400 | ステータス 400 |
| 1-8 | 同じ言語コード | text: "こんにちは", from: "ja", to: "ja" | status: 200, translatedText === text | 元のテキストと同じ |
| 1-9 | 長いテキスト（5000文字） | 長いテキスト | status: 200 | ステータス 200 |
| 1-10 | 特殊文字を含む | text: "!@#$%^&*()", from: "en", to: "ja" | status: 200 | ステータス 200 |

#### 1.2 POST /api/tts/route.ts

| # | テスト項目 | 入力 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 2-1 | 正常なリクエスト（日本語） | text: "こんにちは", lang: "ja" | status: 200, audioBase64: "..." | ステータス 200 かつ base64 形式 |
| 2-2 | 正常なリクエスト（英語） | text: "Hello", lang: "en" | status: 200, audioBase64: "..." | ステータス 200 |
| 2-3 | 無効な言語コード | text: "test", lang: "xx" | status: 400 | ステータス 400 |
| 2-4 | 空のテキスト | text: "", lang: "ja" | status: 400 | ステータス 400 |
| 2-5 | base64 デコード可能性 | 返された audioBase64 | デコード後は有効な音声ファイル形式 | Buffer.from(base64, 'base64') が成功 |

#### 1.3 GET /api/logs/route.ts

| # | テスト項目 | 前提条件 | 期待値 | 合格基準 |
|---|----------|---------|--------|---------|
| 3-1 | ログディレクトリが存在しない | logs/ なし | status: 200, sessions: [] | ステータス 200 かつ配列空 |
| 3-2 | 1つのログファイル | logs/2026-06-22/session_xxx.json | status: 200, sessions: [{ sessionId, ... }] | 1件のセッションが返される |
| 3-3 | 複数ログファイル（日付順） | 2つ以上のログファイル | 新しい順にソート | startedAt の降順 |
| 3-4 | JSON パース失敗ファイル | 不正な JSON ファイル | status: 200, 有効なファイルのみ返す | 不正ファイルはスキップ |
| 3-5 | sessionSummary の型チェック | | { sessionId, machineId, userLang, startedAt, durationSeconds, messageCount } | 全フィールド存在 |

#### 1.4 GET /api/logs/[sessionId]/route.ts

| # | テスト項目 | 入力 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 4-1 | 有効なセッションID | sessionId: "session_123" | status: 200, SessionLog | ステータス 200 かつ transcript 配列 |
| 4-2 | 存在しないセッションID | sessionId: "session_notfound" | status: 404 | ステータス 404 |
| 4-3 | SessionLog 型チェック | | { sessionId, machineId, startedAt, endedAt, transcript[], ... } | 全フィールド存在 |
| 4-4 | transcript 内容チェック | | TranscriptEntry 配列 | 各エントリに speaker, text, timestamp |

---

### 層2: ユーティリティ関数テスト （10項目）

#### 2.1 lib/translateCache.ts

| # | テスト項目 | 入力/操作 | 期待値 | 合格基準 |
|---|----------|---------|--------|---------|
| 5-1 | getCached: 存在するキー | setCache 後に getCached | 保存された値を返す | 返り値 === 保存値 |
| 5-2 | getCached: 存在しないキー | キャッシュなしで getCached | undefined を返す | === undefined |
| 5-3 | setCache: 正常追加 | setCache(text, from, to, result) | Map に追加される | cache.has(key) === true |
| 5-4 | setCache: サイズ500超過 | 501個のエントリを追加 | 最古のエントリが削除 | cache.size === 500 |
| 5-5 | キャッシュキー形式 | text: "hello", from: "en", to: "ja" | キー: "en\|ja\|hello" | cache key === "en|ja|hello" |

#### 2.2 lib/languages.ts

| # | テスト項目 | 入力 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 6-1 | getLang: 日本語 | "ja" | { code: "ja", label: "日本語", flag: "🇯🇵", ... } | code === "ja" |
| 6-2 | getLang: 英語 | "en" | { code: "en", label: "English", flag: "🇬🇧", ... } | code === "en" |
| 6-3 | getLang: 無効コード | "xx" | デフォルト言語を返す | code === "ja" |
| 6-4 | SUPPORTED_LANGS 配列 | | 7言語以上を含む | length >= 7 |
| 6-5 | BCP47 フォーマット | 各言語の bcp47 | "ja-JP", "en-US" など | RFC 5646 に準拠 |

#### 2.3 lib/types.ts

| # | テスト項目 | 確認内容 | 期待値 | 合格基準 |
|---|----------|---------|--------|---------|
| 7-1 | TranscriptEntry 型 | { speaker, text, isFinal, timestamp, ... } | 型定義が正確 | TypeScript でコンパイル成功 |
| 7-2 | SessionLog 型 | { sessionId, startedAt, transcript[], ... } | 型定義が正確 | TypeScript でコンパイル成功 |
| 7-3 | LangCode ユニオン型 | "ja" \| "en" \| ... | 型定義が正確 | 正しい値のみ受け入れ |

---

### 層3: カスタムフックテスト （15項目、モック環境）

#### 3.1 hooks/useSpeechRecognition.ts

| # | テスト項目 | 操作 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 8-1 | start() 呼び出し | start("ja-JP") | listening === true | listening state が true |
| 8-2 | stop() 呼び出し | stop() | listening === false | listening state が false |
| 8-3 | onFinal コールバック | 音声認識完了（モック） | onFinal(text) が呼ばれる | callback 実行 ✓ |
| 8-4 | onInterim コールバック | 音声認識中（モック） | onInterim(text) が呼ばれる | callback 実行 ✓ |
| 8-5 | ブラウザ非対応時 | webkitSpeechRecognition なし | error メッセージを返す | error !== undefined |
| 8-6 | 権限拒否エラー | permission denied（モック） | error に "拒否" を含む | error.includes("拒否") |
| 8-7 | ネットワークエラー | network error（モック） | error に "見つかりません" を含む | error.includes("見つかりません") |

#### 3.2 hooks/useScreenCapture.ts

| # | テスト項目 | 操作 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 9-1 | startCapture() 呼び出し | startCapture("camera") | キャプチャ開始 | onFrame が呼ばれ始める |
| 9-2 | stopCapture() 呼び出し | stopCapture() | キャプチャ停止 | onFrame が呼ばれなくなる |
| 9-3 | フレームレート（FPS） | fps: 5 指定 | 1秒間に約5フレーム | 実際 FPS ≈ 5 |
| 9-4 | フレームサイズ | width: 320, height: 240 | 返されたフレーム: 320x240 | フレームサイズ一致 |
| 9-5 | 圧縮率（quality） | quality: 0.6 | base64 データサイズが削減 | quality: 1.0 より小さい |

#### 3.3 hooks/useSocket.ts

| # | テスト項目 | 操作 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 10-1 | Socket.IO 初期化 | useSocket() | socket オブジェクト作成 | socket !== null |
| 10-2 | 接続状態 | | socket.connected === true | 接続確立 |
| 10-3 | on() リスナー登録 | on("call:answered", ...) | イベント受信時にコールバック実行 | callback 実行 ✓ |
| 10-4 | emit() イベント送信 | emit("call:request", {...}) | イベント送信成功 | emit 実行 ✓ |
| 10-5 | 切断時の処理 | disconnect | cleanup が実行される | リスナー削除 ✓ |

---

### 層4: インテグレーションテスト （25項目）

#### 4.1 Socket.IO サーバー通信フロー

| # | テスト項目 | シナリオ | 期待値 | 合格基準 |
|---|----------|--------|--------|---------|
| 11-1 | call:request | キオスク送信 | サーバー受信・スタッフに通知 | call-queue room に emit |
| 11-2 | call:answer (成功) | スタッフ1が応答 | call:answered を返す | sessionId が返される |
| 11-3 | call:answer (競合) | スタッフ1,2 同時応答 | 1人だけ成功、もう1人に call:alreadyTaken | 競合制御成功 |
| 11-4 | speech:user | キオスク送信 | スタッフに中継 | staff に emit |
| 11-5 | speech:staff | スタッフ送信 | キオスクに中継 | user に emit |
| 11-6 | 翻訳中継 | ユーザー言語: en | サーバーが日→英翻訳 | translatedText に英語 |
| 11-7 | call:end | キオスク/スタッフ送信 | セッション削除・相手に通知 | activeSessions から削除 |
| 11-8 | ログ保存 | 通話終了時 | JSON ファイル作成 | logs/{date}/{sessionId}.json 存在 |
| 11-9 | 複数セッション同時 | 3セッション並行 | 各セッション独立 | 干渉なし |
| 11-10 | staff:join | スタッフ接続 | 在籍リストに追加 | staffMap に追加 |
| 11-11 | staff:leave | スタッフ切断 | 在籍リストから削除 | staffMap から削除 |
| 11-12 | screen:frame | スタッフ→キオスク | フレーム中継 | user に emit |
| 11-13 | tts:audio | サーバー→クライアント | 音声データ配信 | audioBase64 が返される |
| 11-14 | 接続切断時処理 | socket.disconnect() | セッション自動クリーンアップ | 孤立セッション削除 |
| 11-15 | エコー検出 | アバター音声と同じテキスト認識 | エコー除外（マイクOFF） | interimUser 保持せず |

#### 4.2 API 連携フロー

| # | テスト項目 | フロー | 期待値 | 合格基準 |
|---|----------|-------|--------|---------|
| 12-1 | 翻訳 → TTS | speech:user (en) → 翻訳 (ja) → TTS | 日本語音声生成 | 1. 翻訳成功 2. TTS 成功 |
| 12-2 | キャッシュ最適化 | 同じテキスト2回目 | API 呼び出さず | キャッシュから返却 |
| 12-3 | ログ保存 → 取得 | call:end → GET /api/logs → GET /api/logs/[id] | ログ保存・取得可能 | JSON ファイル内容一致 |
| 12-4 | エラーリカバリ | API 失敗時 | グレースフル失敗・ユーザー通知 | エラーメッセージ表示 |
| 12-5 | タイムアウト処理 | API 応答なし（3秒待機） | タイムアウトエラー | error thrown ✓ |

#### 4.3 ロジック検証

| # | テスト項目 | 条件 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 13-1 | 競合制御 | 2 staff 同時 call:answer | 1 staff だけ接続 | call:alreadyTaken 送信 |
| 13-2 | ステータス自動リセット | 全セッション終了 | status: "busy" → "available" | useEffect で自動更新 |
| 13-3 | マイク自動OFF | スタッフ speech:staff 受信 | キオスクマイク OFF | micOnRef.current === false |
| 13-4 | 言語保持 | 言語選択後 | 複数発言で同じ言語 | userLangRef で保持 |
| 13-5 | sessionStorage 独立 | 複数キオスク端末タブ | 各タブで独立した staffName | タブ間干渉なし |

#### 4.4 エラーハンドリング・エッジケース

| # | テスト項目 | 条件 | 期待値 | 合格基準 |
|---|----------|------|--------|---------|
| 14-1 | ネットワーク断線 | socket disconnect → reconnect | 自動再接続試行 | reconnect event |
| 14-2 | 不正な JSON | 不正な payload 送信 | サーバーがエラー捕捉 | try-catch 有効 |
| 14-3 | 大量同時セッション | 100+ sessions | サーバー正常動作 | memory leak なし |
| 14-4 | 長時間実行 | 1時間連続実行 | activeSessions 正常管理 | memory 増加なし |
| 14-5 | ファイルシステム満杯 | logs/ ディスク満杯 | エラー捕捉・ログ記録 | error handling ✓ |

---

## テスト実行ログ形式

### コマンド別ログ出力

**1. 通常実行: `npm test`**
```
PASS  app/api/translate.test.ts
  ✓ 正常なリクエスト（日→英）(12ms)
  ✓ キャッシュヒット（同一テキスト2回）(5ms)
  ✓ 無効な言語コード（from）(8ms)
  (省略)

PASS  server/socketServer.test.ts
  ✓ call:request（キオスク送信）(45ms)
  ✓ call:answer（スタッフ応答）(38ms)
  (省略)

FAIL  lib/languages.test.ts
  ✗ getLang: 無効コード
    Expected: { code: 'ja' }
    Received: { code: 'en' }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tests:       95 passed, 1 failed, 96 total
Suites:      8 passed, 1 failed, 9 total
Time:        8.234s
Coverage:    89% statements, 87% branches
```

**2. 詳細ログ: `npm test -- --verbose`**
```
PASS  app/api/translate.test.ts (5.234s)
  POST /api/translate
    ✓ 正常なリクエスト（日→英） (12ms)
      [Input] text: "こんにちは", from: "ja", to: "en"
      [Output] status: 200, translatedText: "Hello"
    ✓ キャッシュヒット（同一テキスト2回） (5ms)
      [Execution Time] 1st: 45ms, 2nd: 3ms
      [Cache Hit] true
    ✗ 無効な言語コード（from） (8ms)
      [Input] text: "test", from: "xx", to: "en"
      [Expected] status: 400, error: "Invalid language code"
      [Actual] status: 200, translatedText: "prueba"
      [Cause] API route で from パラメータ検証がない
      [File Location] app/api/translate/route.ts:15-20
      [Suggested Fix]
        if (!SUPPORTED_LANGS.some(l => l.code === from)) {
          return NextResponse.json({error: "Invalid language"}, {status: 400});
        }
```

**3. カバレッジレポート: `npm test -- --coverage`**
```
─────────────────────────────────────────
File                      | % Stmts | % Branch | % Funcs | % Lines
─────────────────────────────────────────
All files                 |    89.2 |    87.1  |   91.5  |   89.0
 app/api/translate        |    92.1 |    89.3  |   95.0  |   92.0
 app/api/tts              |    88.5 |    85.2  |   90.0  |   88.0
 server/socketServer      |    87.3 |    84.1  |   88.5  |   87.0
 lib/translateCache       |    100  |    100   |   100   |   100
 hooks/useSpeech          |    85.2 |    82.0  |   86.0  |   85.0
─────────────────────────────────────────
```

---

## 合格基準（全体）

| 項目 | 基準 | 判定 |
|------|------|------|
| **テスト成功率** | 95% 以上（96/96中 95個以上） | PASS |
| **カバレッジ** | 85% 以上 | PASS |
| **ステートメント** | 85% 以上 | PASS |
| **ブランチ** | 80% 以上 | PASS |
| **実行時間** | 全テスト 30秒以内 | PASS |

---

## ログ出力の詳細度設定

```bash
# 最小限のログ（成功テスト数のみ）
npm test

# 詳細ログ（全テスト内容表示）
npm test -- --verbose

# カバレッジ付き詳細ログ
npm test -- --verbose --coverage

# 特定ファイルのテストのみ
npm test -- app/api/translate.test.ts

# 特定テストのみ（名前で検索）
npm test -- -t "正常なリクエスト"

# 失敗したテストのみ再実行
npm test -- --onlyChanged
```

---

## 記録される情報（成功・失敗両方）

✅ **成功時も記録される**

- テスト名
- 実行時間
- 入力値（Input）
- 期待値（Expected）
- 実際の値（Actual）
- キャッシュヒット有無
- メモリ使用量

❌ **失敗時のさらに詳細な記録**

- エラーメッセージ
- スタックトレース
- 発生したファイル・行番号
- 修正案
- 原因推定

