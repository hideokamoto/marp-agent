/** AgentCore Runtime HTTPサーバー
 *
 * Python版は bedrock_agentcore SDK（BedrockAgentCoreApp）がHTTP層を提供していた。
 * Node版はAgentCoreランタイムコントラクトを直接実装する：
 *   - GET  /ping         → ヘルスチェック
 *   - POST /invocations  → SSEストリーミング（data: {...}\n\n 形式）
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { invoke, type InvokePayload } from './invoke.js';
import { runWithInvocationState } from './state.js';

const PORT = 8080;
const MAX_BODY_BYTES = 32 * 1024 * 1024; // 参考資料PDF（10MB, base64で約14MB）を余裕を持って受ける

const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleInvocation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let payload: InvokePayload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body.toString('utf-8')) as InvokePayload;
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Invalid request body: ${e instanceof Error ? e.message : String(e)}` }));
    return;
  }

  const sessionId = (req.headers[SESSION_HEADER] as string | undefined) ?? null;
  console.log(`[INFO] Invocation received (action=${payload.action ?? 'chat'}, session=${sessionId ?? 'none'})`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  try {
    await runWithInvocationState(async () => {
      for await (const event of invoke(payload, sessionId)) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
  } catch (e) {
    console.error(`[ERROR] Invocation failed: ${e}`);
    res.write(`data: ${JSON.stringify({ type: 'error', error: e instanceof Error ? e.message : String(e) })}\n\n`);
  }
  res.end();
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/invocations') {
    void handleInvocation(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// エクスポート処理（Chromiumレンダリング等）があるためタイムアウトを長めに設定
server.requestTimeout = 15 * 60 * 1000;
server.headersTimeout = 65 * 1000;

server.listen(PORT, () => {
  console.log(`[INFO] AgentCore runtime listening on :${PORT}`);
});
