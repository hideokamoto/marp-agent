/** Web検索ツール（Tavily API）— Python版 web_search.py の移植 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { tavily, type TavilyClient } from '@tavily/core';
import { getInvocationState } from '../state.js';

/** Tavilyクライアント初期化（カンマ区切りで複数キー対応、枯渇時は自動フォールバック） */
export function createTavilyClients(apiKeys: string | undefined = process.env.TAVILY_API_KEYS): TavilyClient[] {
  return (apiKeys ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => key.length > 0)
    .map((key) => tavily({ apiKey: key }));
}

let defaultClients: TavilyClient[] | null = null;

function getDefaultClients(): TavilyClient[] {
  if (defaultClients === null) {
    defaultClients = createTavilyClients();
  }
  return defaultClients;
}

/** テスト用: クライアントを差し替える */
export function setTavilyClientsForTesting(clients: TavilyClient[] | null): void {
  defaultClients = clients;
}

interface SearchResultItem {
  title?: string;
  content?: string;
  url?: string;
}

/** ツール本体のロジック（テストから直接呼べるように分離） */
export async function executeWebSearch(query: string, clients: TavilyClient[] = getDefaultClients()): Promise<string> {
  if (clients.length === 0) {
    return 'Web検索機能は現在利用できません（APIキー未設定）';
  }

  // 複数APIキーで順番に試行（無料枠の月5000リクエスト制限対策）
  for (const client of clients) {
    try {
      const results = await client.search(query, {
        maxResults: 3,
        searchDepth: 'basic',
      });
      // レスポンス内に利用制限エラーが含まれていたら次のキーで再試行
      const resultsStr = JSON.stringify(results).toLowerCase();
      if (resultsStr.includes('usage limit') || resultsStr.includes('exceeds your plan')) {
        continue;
      }
      // 検索結果をテキストに整形
      const items: SearchResultItem[] = (results as { results?: SearchResultItem[] }).results ?? [];
      const formatted = items.map(
        (r) => `**${r.title ?? ''}**\n${r.content ?? ''}\nURL: ${r.url ?? ''}`
      );
      const searchResult = formatted.length > 0 ? formatted.join('\n\n---\n\n') : '検索結果がありませんでした';
      getInvocationState().lastSearchResult = searchResult; // フォールバック用に保存
      return searchResult;
    } catch (e) {
      // rate limit系のエラーなら次のキーで再試行、それ以外は即座にエラー返却
      const errorStr = String(e).toLowerCase();
      if (
        errorStr.includes('rate limit') ||
        errorStr.includes('429') ||
        errorStr.includes('quota') ||
        errorStr.includes('usage limit')
      ) {
        continue;
      }
      return `検索エラー: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 全キー枯渇
  return '現在、利用殺到で検索API無料枠が枯渇したようです。修正をお待ちください';
}

export const webSearchTool = createTool({
  id: 'web_search',
  description: `Web検索を実行して最新情報を取得します。最新の統計・事例・製品情報など、スライド作成に必要な情報を調べる際に使用してください。

## 使い方のルール

- 検索結果が不十分な場合は異なるクエリで再検索してOK
- Web検索時は最後のスライドに参考文献スライドを追加すること（Marp形式なら \`<!-- _class: tinytext -->\` 付き）
- エラー時（APIキー未設定・rate limit・usage limit等）はスライドを作成せず、検索APIの無料枠が枯渇した旨を案内する
- 検索結果のsnippetだけでスライドは十分作れる。検索結果のURLにhttp_requestでアクセスしてはいけない`,
  inputSchema: z.object({
    query: z.string().describe('検索クエリ（日本語または英語）'),
  }),
  execute: async ({ context }) => executeWebSearch(context.query),
});
