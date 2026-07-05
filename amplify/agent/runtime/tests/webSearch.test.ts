/** web_search ツールのユニットテスト — Python版 test_web_search_unit.py の移植（外部API不要） */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeWebSearch, createTavilyClients } from '../src/tools/webSearch.js';
import { getInvocationState, resetFallbackState } from '../src/state.js';
import type { TavilyClient } from '@tavily/core';

function fakeClient(impl: (query: string) => Promise<unknown>): TavilyClient {
  return { search: impl } as unknown as TavilyClient;
}

beforeEach(() => {
  resetFallbackState();
});

describe('createTavilyClients', () => {
  it('カンマ区切りの複数キーからクライアントを生成', () => {
    expect(createTavilyClients('key1, key2 ,key3')).toHaveLength(3);
  });

  it('空文字・未設定なら空配列', () => {
    expect(createTavilyClients('')).toHaveLength(0);
    expect(createTavilyClients(undefined)).toHaveLength(0);
    expect(createTavilyClients(' , ,')).toHaveLength(0);
  });
});

describe('executeWebSearch', () => {
  it('APIキー未設定の場合はエラーメッセージを返す', async () => {
    const result = await executeWebSearch('test query', []);
    expect(result).toContain('利用できません');
  });

  it('検索結果を正しくフォーマットする', async () => {
    const client = fakeClient(async () => ({
      results: [
        { title: 'Test Title', content: 'Test content', url: 'https://example.com' },
        { title: 'Title 2', content: 'Content 2', url: 'https://example2.com' },
      ],
    }));

    const result = await executeWebSearch('test', [client]);

    expect(result).toContain('Test Title');
    expect(result).toContain('Test content');
    expect(result).toContain('https://example.com');
    expect(result).toContain('---'); // セパレータ
    // フォールバック用に保存される
    expect(getInvocationState().lastSearchResult).toBe(result);
  });

  it('検索結果が空の場合', async () => {
    const client = fakeClient(async () => ({ results: [] }));
    const result = await executeWebSearch('test', [client]);
    expect(result).toContain('検索結果がありませんでした');
  });

  it('API例外時はエラーメッセージを返す', async () => {
    const client = fakeClient(async () => {
      throw new Error('Connection error');
    });
    const result = await executeWebSearch('test', [client]);
    expect(result).toContain('検索エラー');
    expect(result).toContain('Connection error');
  });

  it('rate limitエラーは次のキーにフォールバックする', async () => {
    const limited = fakeClient(async () => {
      throw new Error('429 rate limit exceeded');
    });
    const ok = fakeClient(async () => ({
      results: [{ title: 'Fallback', content: 'ok', url: 'https://example.com' }],
    }));

    const result = await executeWebSearch('test', [limited, ok]);
    expect(result).toContain('Fallback');
  });

  it('usage limitを含むレスポンスは次のキーで再試行する', async () => {
    const exhausted = fakeClient(async () => ({ detail: 'usage limit exceeded' }));
    const ok = fakeClient(async () => ({
      results: [{ title: 'Second', content: 'ok', url: 'https://example.com' }],
    }));

    const result = await executeWebSearch('test', [exhausted, ok]);
    expect(result).toContain('Second');
  });

  it('全キー枯渇時は案内メッセージを返す', async () => {
    const limited = fakeClient(async () => {
      throw new Error('quota exceeded');
    });
    const result = await executeWebSearch('test', [limited, limited]);
    expect(result).toContain('枯渇');
  });
});
