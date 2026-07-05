/** HTTPリクエストツール（Haiku要約付き）— Python版 http_request.py の移植
 *
 * Webページ全文を返すと会話履歴のトークンが膨らむため、
 * 大きなレスポンスはClaude Haikuで要約してコスト削減する。
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// 要約を適用するしきい値（この文字数以下ならそのまま返す）
export const SUMMARIZE_THRESHOLD = 5000;

// Haiku要約用の入力上限（これ以上はHaikuにも送らない）
export const HAIKU_INPUT_LIMIT = 50000;

const HAIKU_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const REQUEST_TIMEOUT_MS = 30000;

let bedrockClient: BedrockRuntimeClient | null = null;

function getBedrockClient(): BedrockRuntimeClient {
  if (bedrockClient === null) {
    bedrockClient = new BedrockRuntimeClient({ region: 'us-east-1' });
  }
  return bedrockClient;
}

/** HTMLからテキストを簡易抽出 */
export function htmlToText(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

/** Claude Haikuでコンテンツを要約 */
async function summarizeWithHaiku(content: string): Promise<string> {
  const client = getBedrockClient();
  const response = await client.send(
    new ConverseCommand({
      modelId: HAIKU_MODEL_ID,
      messages: [
        {
          role: 'user',
          content: [
            {
              text:
                '以下のWebページ内容を、スライド作成の参考資料として簡潔に要約してください。\n' +
                '固有名詞、数値、重要な事実は必ず保持してください。\n\n' +
                content,
            },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 2000 },
    })
  );
  return response.output?.message?.content?.[0]?.text ?? '';
}

/** ツール本体のロジック（テストから直接呼べるように分離） */
export async function executeHttpRequest(url: string, method: string = 'GET'): Promise<string> {
  try {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let content = await response.text();
    const originalLength = content.length;

    // HTMLレスポンスはテキスト抽出
    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType.includes('text/html')) {
      content = htmlToText(content);
    }

    // 一定サイズ以上の場合はHaikuで要約
    if (content.length > SUMMARIZE_THRESHOLD) {
      try {
        const summary = await summarizeWithHaiku(content.slice(0, HAIKU_INPUT_LIMIT));
        content = `（以下はWebページの要約です - 元の文字数: ${originalLength}）\n\n${summary}`;
      } catch (e) {
        // 要約失敗時はフォールバックで切り詰め
        console.warn(`[WARN] Haiku summarization failed, truncating: ${e}`);
        content =
          content.slice(0, SUMMARIZE_THRESHOLD) +
          `\n\n（以降省略 - 全${originalLength}文字中、先頭${SUMMARIZE_THRESHOLD}文字を表示）`;
      }
    }

    return `Status: ${response.status}\n\n${content}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export const httpRequestTool = createTool({
  id: 'http_request',
  description: `ユーザーがメッセージに貼ったURLのWebページを取得します。

**使用条件**: ユーザーがURLを直接メッセージに貼った場合のみ使用してください。
web_searchの検索結果URLには使用しないこと（snippetで十分スライドは作れる）。

## 自動処理

- HTMLは自動でテキスト変換（script/styleタグ除去）
- 5,000文字超のレスポンスはClaude Haikuが要約（固有名詞・数値・事実を保持）
- 要約失敗時は先頭5,000文字を切り詰めて返す

## 制約

- タイムアウト: 30秒
- 認証が必要なページ・動的JSレンダリングページは取得不可
- PDF・画像・動画URLはテキストとして取得不可`,
  inputSchema: z.object({
    url: z.string().describe('リクエスト先のURL（HTTPまたはHTTPS）'),
    method: z.string().optional().describe('HTTPメソッド（デフォルト: GET）'),
  }),
  execute: async ({ context }) => executeHttpRequest(context.url, context.method ?? 'GET'),
});
