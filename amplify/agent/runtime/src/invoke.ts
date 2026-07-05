/** エージェント実行（ストリーミング対応）— Python版 agent.py の invoke の移植 */

import type { CoreMessage } from 'ai';
import { getOrCreateAgent } from './agentFactory.js';
import { sessionKey, getHistory, appendExchange } from './sessionManager.js';
import { getInvocationState } from './state.js';
import { generatePdf, generatePptx, generateEditablePptx } from './exports/slideExporter.js';
import { isDeckSource, generateDeckPdf, generateDeckPptx } from './exports/deckExporter.js';
import { shareSlide } from './sharing/s3Uploader.js';
import { extractTextFromPdf, MAX_PDF_SIZE } from './pdfExtract.js';

const STREAM_KEEPALIVE_MS = 10000; // ストリーミング中のkeep-alive間隔
const EXPORT_KEEPALIVE_MS = 5000; // 変換中のkeep-alive間隔
const MAX_AGENT_STEPS = 10; // ツール実行を含むエージェントループの上限

export interface ReferenceFile {
  file_name?: string;
  base64_data?: string;
  size?: number;
}

export interface InvokePayload {
  prompt?: string;
  action?: string;
  markdown?: string;
  model_type?: string;
  theme?: string;
  reference_file?: ReferenceFile;
}

export type AgentEvent = Record<string, unknown>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** タスク完了を待ちつつ、一定間隔でkeep-aliveイベントをyield */
async function* progressWhilePending(task: Promise<unknown>, message: string): AsyncGenerator<AgentEvent> {
  // 完了・失敗どちらでもループを抜ける（エラーは呼び出し元のawaitで処理）
  const settled = task.then(
    () => true,
    () => true
  );
  while (true) {
    const done = await Promise.race([settled, sleep(EXPORT_KEEPALIVE_MS).then(() => false)]);
    if (done) return;
    yield { type: 'progress', message: `${message}変換中...` };
  }
}

/** ツール呼び出しをtool_useイベントに変換 */
function toolUseEvent(toolName: string, args: unknown): AgentEvent {
  const input = (args ?? {}) as Record<string, unknown>;
  if (toolName === 'web_search' && typeof input.query === 'string') {
    return { type: 'tool_use', data: toolName, query: input.query };
  }
  if (toolName === 'http_request' && typeof input.url === 'string') {
    return { type: 'tool_use', data: toolName, query: input.url };
  }
  return { type: 'tool_use', data: toolName };
}

/** エージェント実行（ストリーミング対応） */
export async function* invoke(payload: InvokePayload, sessionId: string | null): AsyncGenerator<AgentEvent> {
  const state = getInvocationState();

  let userMessage = payload.prompt ?? '';
  const action = payload.action ?? 'chat';
  const currentMarkdown = payload.markdown ?? '';
  const modelType = payload.model_type ?? 'sonnet';
  const theme = payload.theme ?? 'border';
  const referenceFile = payload.reference_file;

  // スライドソースの形式判定（折衷=HTMLデッキ / それ以外=Marpマークダウン）
  const isDeck = currentMarkdown.length > 0 && isDeckSource(currentMarkdown);

  // PDF出力
  if (action === 'export_pdf' && currentMarkdown) {
    try {
      console.log(`[INFO] PDF export started (theme=${theme}, deck=${isDeck})`);
      const task = isDeck ? generateDeckPdf(currentMarkdown) : generatePdf(currentMarkdown, theme);
      yield* progressWhilePending(task, 'PDF');
      const pdfBytes = await task;
      console.log(`[INFO] PDF export completed (size=${pdfBytes.length} bytes)`);
      yield { type: 'pdf', data: pdfBytes.toString('base64') };
    } catch (e) {
      console.error(`[ERROR] PDF export failed: ${e}`);
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    return;
  }

  // PPTX出力
  if (action === 'export_pptx' && currentMarkdown) {
    try {
      console.log(`[INFO] PPTX export started (theme=${theme}, deck=${isDeck})`);
      const task = isDeck ? generateDeckPptx(currentMarkdown) : generatePptx(currentMarkdown, theme);
      yield* progressWhilePending(task, 'PPTX');
      const pptxBytes = await task;
      console.log(`[INFO] PPTX export completed (size=${pptxBytes.length} bytes)`);
      yield { type: 'pptx', data: pptxBytes.toString('base64') };
    } catch (e) {
      console.error(`[ERROR] PPTX export failed: ${e}`);
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    return;
  }

  // 編集可能PPTX出力（実験的機能）
  if (action === 'export_pptx_editable' && currentMarkdown) {
    if (isDeck) {
      yield { type: 'error', message: '折衷デザインでは編集可能PPTXは未対応です（PPTX形式をご利用ください）' };
      return;
    }
    try {
      console.log(`[INFO] Editable PPTX export started (theme=${theme})`);
      const task = generateEditablePptx(currentMarkdown, theme);
      yield* progressWhilePending(task, '編集可能PPTX');
      const pptxBytes = await task;
      console.log(`[INFO] Editable PPTX export completed (size=${pptxBytes.length} bytes)`);
      yield { type: 'pptx', data: pptxBytes.toString('base64') };
    } catch (e) {
      console.error(`[ERROR] Editable PPTX export failed: ${e}`);
      yield { type: 'error', message: `編集可能PPTX生成エラー（実験的機能）: ${e instanceof Error ? e.message : String(e)}` };
    }
    return;
  }

  // スライド共有
  if (action === 'share_slide' && currentMarkdown) {
    try {
      console.log(`[INFO] Slide share started (theme=${theme})`);
      const task = shareSlide(currentMarkdown, theme);
      yield* progressWhilePending(task, '共有');
      const result = await task;
      console.log(`[INFO] Slide share completed (url=${result.url})`);
      yield { type: 'share_result', url: result.url, expiresAt: result.expiresAt };
    } catch (e) {
      console.error(`[ERROR] Slide share failed: ${e}`);
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    }
    return;
  }

  // 参考資料PDFの処理
  if (referenceFile) {
    try {
      const fileName = referenceFile.file_name ?? 'upload.pdf';
      const base64Data = referenceFile.base64_data ?? '';
      const fileSize = referenceFile.size ?? 0;

      if (fileSize > MAX_PDF_SIZE) {
        yield { type: 'error', error: 'ファイルサイズが10MBを超えています' };
        return;
      }

      yield { type: 'status', data: '参考資料を読み込んでいます...' };
      console.log(`[INFO] PDF upload received: ${fileName} (${fileSize} bytes)`);

      const pdfBytes = Buffer.from(base64Data, 'base64');
      const extractedText = await extractTextFromPdf(pdfBytes);

      if (!extractedText.trim()) {
        console.warn(`[WARN] No text extracted from PDF: ${fileName}`);
        yield {
          type: 'text',
          data: 'このPDFからテキストを抽出できませんでした（画像ベースのPDFの可能性があります）。テキスト情報なしでスライドを作成します。\n\n',
        };
      } else {
        console.log(`[INFO] PDF text extracted: ${extractedText.length} chars from ${fileName}`);
        userMessage = `以下は参考資料「${fileName}」の内容です：

---参考資料ここから---
${extractedText}
---参考資料ここまで---

上記の参考資料を踏まえて、${userMessage}`;
      }
    } catch (e) {
      console.error(`[ERROR] PDF processing failed: ${e}`);
      yield {
        type: 'text',
        data: `PDFの読み取りに失敗しました: ${e instanceof Error ? e.message : String(e)}\nテキスト情報なしでスライドを作成します。\n\n`,
      };
    }
  }

  // セッションIDとモデルタイプとテーマに対応するAgentと履歴を取得
  const agent = getOrCreateAgent(modelType, theme);
  const historyKey = sessionKey(sessionId, modelType, theme);
  const history = getHistory(historyKey);

  // 既存セッション（履歴にスライド内容が残っている）ではMarkdown付加をスキップ
  // 新規セッションまたは履歴がない場合のみ、フロントからのスライドソースをメッセージに結合
  if (currentMarkdown && history.length === 0) {
    userMessage = `現在のスライド:\n\`\`\`markdown\n${currentMarkdown}\n\`\`\`\n\nユーザーの指示: ${userMessage}`;
  }

  let webSearchExecuted = false;
  let slideOutputted = false;
  let suppressText = false;
  let assistantText = '';

  try {
    const messages: CoreMessage[] = [...history, { role: 'user', content: userMessage }];
    const result = await agent.stream(messages, { maxSteps: MAX_AGENT_STEPS });
    const iterator = result.fullStream[Symbol.asyncIterator]();

    let pending = iterator.next();
    while (true) {
      const winner = await Promise.race([
        pending.then((r) => ({ r })),
        sleep(STREAM_KEEPALIVE_MS).then(() => null),
      ]);
      if (winner === null) {
        yield { type: 'progress', message: '処理中...' };
        continue;
      }
      if (winner.r.done) break;
      const part = winner.r.value;

      if (part.type === 'text-delta') {
        assistantText += part.textDelta;
        // output_slide / output_deck 完了後はテキスト送信を抑制
        if (!suppressText) {
          if (state.generatedSlideSource) {
            yield { type: 'markdown', data: state.generatedSlideSource };
            state.generatedSlideSource = null;
            slideOutputted = true;
            suppressText = true;
          } else {
            yield { type: 'text', data: part.textDelta };
          }
        }
      } else if (part.type === 'tool-call') {
        if (part.toolName === 'web_search') {
          webSearchExecuted = true;
        }
        yield toolUseEvent(part.toolName, part.args);
      } else if (part.type === 'tool-result' || part.type === 'step-finish') {
        // ツール完了直後にスライドソースを送信（スピナーを即座に停止）
        if (state.generatedSlideSource) {
          yield { type: 'markdown', data: state.generatedSlideSource };
          state.generatedSlideSource = null;
          slideOutputted = true;
          suppressText = true;
        }
      } else if (part.type === 'error') {
        console.error(`[ERROR] Stream part error (model_type=${modelType}): ${JSON.stringify(part.error)}`);
        yield { type: 'error', error: String(part.error) };
      }

      pending = iterator.next();
    }
  } catch (e) {
    console.error(`[ERROR] Stream failed (model_type=${modelType}): ${e}`);
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
  }

  // スライドソース出力（ループ内で未送信の場合）
  if (state.generatedSlideSource) {
    yield { type: 'markdown', data: state.generatedSlideSource };
    state.generatedSlideSource = null;
    slideOutputted = true;
  }

  // Web検索後にスライドが生成されなかった場合のフォールバック
  if (webSearchExecuted && !slideOutputted && state.lastSearchResult) {
    let truncated = state.lastSearchResult.slice(0, 500);
    if (state.lastSearchResult.length > 500) truncated += '...';
    console.log(`[INFO] Web search executed but no slide generated, returning search result as fallback (model_type=${modelType})`);
    yield { type: 'text', data: `Web検索結果:\n\n${truncated}\n\n---\nスライドを作成しますか？` };
  }

  // ツイートURL出力
  if (state.generatedTweetUrl) {
    yield { type: 'tweet_url', data: state.generatedTweetUrl };
  }

  // 会話履歴を更新（スライディングウィンドウ）
  appendExchange(historyKey, userMessage, assistantText);

  yield { type: 'done' };
}
