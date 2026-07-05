/** ツイートURL生成ツール — Python版 generate_tweet.py の移植 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getInvocationState } from '../state.js';

/** ツール本体のロジック（テストから直接呼べるように分離） */
export function executeGenerateTweetUrl(tweetText: string): string {
  // 日本語をURLエンコード
  const encodedText = encodeURIComponent(tweetText);
  // Twitter Web Intent（compose/postではtextパラメータが無視される）
  getInvocationState().generatedTweetUrl = `https://twitter.com/intent/tweet?text=${encodedText}`;
  return 'ツイートURLを生成しました。';
}

export const generateTweetUrlTool = createTool({
  id: 'generate_tweet_url',
  description: `ツイート投稿用のURLを生成します。ユーザーがXでシェアしたい場合に使用してください。

## ツイート本文のフォーマット

\`#パワポ作るマン で○○のスライドを作ってみました。これは便利！ pawapo.minoruonda.com\`
（100文字以内に収める）`,
  inputSchema: z.object({
    tweet_text: z.string().describe('ツイート本文（100文字以内、ハッシュタグ含む）'),
  }),
  execute: async ({ context }) => executeGenerateTweetUrl(context.tweet_text),
});
