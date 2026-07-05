# Mastraランタイム（TypeScript）

2026-07にエージェントランタイムをStrands Agents（Python）から**Mastra（TypeScript）**へ移行した。
AgentCore RuntimeのHTTPコントラクトとフロントとのSSEイベント形式は維持しているため、
フロントエンド・CDK・認証まわりに変更はない。

## 構成

```
[POST /invocations] → src/server.ts（node:httpでSSE配信）
        │
        ▼
src/invoke.ts（アクションルーティング: chat / export_* / share_slide）
        │
        ├── src/agentFactory.ts   Mastra Agent（@ai-sdk/amazon-bedrock経由でBedrock呼び出し）
        ├── src/tools/            output_slide, output_deck, web_search, generate_tweet_url, http_request
        ├── src/exports/          slideExporter（Marp CLI）, deckExporter（playwright-core + pptxgenjs + pdf-lib）
        ├── src/sharing/          s3Uploader（S3 + OGP）
        └── src/sessionManager.ts 会話履歴（スライディングウィンドウ6件）
```

## AgentCoreコントラクトの自前実装

Python版は `bedrock_agentcore` SDK（`BedrockAgentCoreApp`）がHTTP層を提供していたが、
NodeにはSDKがないため `src/server.ts` で直接実装している：

- `GET /ping` → `{"status": "Healthy"}`
- `POST /invocations` → `text/event-stream`。`data: {JSON}\n\n` 形式で
  `{type: text|markdown|tool_use|progress|status|error|pdf|pptx|share_result|tweet_url|done}` を流す
- セッションIDはリクエストヘッダー `x-amzn-bedrock-agentcore-runtime-session-id` から取得

## Python版との対応表

| Python（旧） | TypeScript（新） |
|---|---|
| agent.py の `invoke` | src/invoke.ts |
| BedrockAgentCoreApp | src/server.ts（node:http） |
| config.py | src/config.ts |
| session/manager.py（Agentキャッシュ） | src/agentFactory.ts（Agent）+ src/sessionManager.ts（履歴） |
| tools/*.py のモジュールグローバル変数 | src/state.ts（AsyncLocalStorage、呼び出し単位で分離） |
| exports/slide_exporter.py（Marp CLI） | src/exports/slideExporter.ts |
| exports/deck_exporter.py + render_deck.mjs | src/exports/deckExporter.ts（playwright-coreをインプロセス実行） |
| python-pptx / img2pdf | pptxgenjs / pdf-lib |
| pdfplumber（参考資料PDF） | pdf-parse（src/pdfExtract.ts） |
| sharing/s3_uploader.py（boto3） | src/sharing/s3Uploader.ts（@aws-sdk/client-s3） |
| tests/（pytest 71件） | amplify/agent/runtime/tests/（vitest 89件） |

## 実装メモ

- **モデル呼び出し**: `@ai-sdk/amazon-bedrock`（AI SDK v4系）+ `fromNodeProviderChain()`。
  モデルIDは config.ts（sonnet: `us.anthropic.claude-sonnet-4-6` / opus: `us.anthropic.claude-opus-4-6-v1`）
- **エージェントループ**: `agent.stream(messages, { maxSteps: 10 })` の `fullStream` を反復。
  `text-delta`→text、`tool-call`→tool_use、ツール完了後に状態からスライドソースを検出して
  markdownイベント送信＆以降のテキスト抑制（Python版と同じ挙動）
- **keep-alive**: チャット中は10秒、エクスポート中は5秒間隔でprogressイベントを送出
- **会話履歴**: Strandsの `SlidingWindowConversationManager(window_size=6)` 相当を
  sessionManager.tsで自前実装（user/assistantテキストのみ保持、ツール呼び出しは持ち越さない）
- **プロンプトキャッシュ**: Strands版の `cache_prompt="default"` 相当は未設定（TODO）。
  折衷テーマはシステムプロンプトが約50KBあるため、コストが問題になったら
  AI SDKのbedrock `cachePoint` の導入を検討する
- **Observability**: Python版の `opentelemetry-instrument`（ADOT自動計装）は未移植（TODO）。
  resource.ts の OTEL_PYTHON_* 環境変数は削除済み

## 開発コマンド

```bash
cd amplify/agent/runtime
npm install          # 初回のみ
npm run build        # tsc（dist/へ）
npm run dev          # tsxでローカル起動（要 PUPPETEER_EXECUTABLE_PATH）
npm test             # vitest（89件、外部API不要）
```

ローカルでサーバーを立ててエクスポートを試す場合：

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npx tsx src/server.ts
curl http://localhost:8080/ping
curl -X POST http://localhost:8080/invocations -H 'Content-Type: application/json' \
  -d '{"action":"export_pptx","markdown":"...","theme":"eclectic"}'
```

## Dockerイメージ

`node:22-bookworm-slim`（ARM64）ベース。Chromium・fonts-noto-cjk・LibreOffice Impress
（編集可能PPTX用）・Marp CLIをインストールし、`npm ci` → `tsc` → `npm prune --omit=dev`。
テーマCSSはビルド時に `npm run copy-themes` でランタイムルートへコピーされたものを `COPY *.css ./` で取り込む（従来と同じ）。
