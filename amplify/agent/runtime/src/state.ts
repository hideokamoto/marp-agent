/**
 * 呼び出し単位の状態管理
 *
 * Python版はモジュールグローバル変数を使っていたが、Node版では
 * AsyncLocalStorageで呼び出し（/invocations 1リクエスト）ごとに分離する。
 * ALSコンテキスト外（ユニットテスト等）ではモジュールレベルの
 * フォールバック状態を使う。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface InvocationState {
  /** output_slide / output_deck が出力したスライドソース */
  generatedSlideSource: string | null;
  /** output_slide のあふれリトライ回数 */
  slideOverflowRetryCount: number;
  /** output_deck の構造リトライ回数 */
  deckRetryCount: number;
  /** generate_tweet_url が生成したURL */
  generatedTweetUrl: string | null;
  /** web_search の最後の検索結果（フォールバック用） */
  lastSearchResult: string | null;
}

export function createInvocationState(): InvocationState {
  return {
    generatedSlideSource: null,
    slideOverflowRetryCount: 0,
    deckRetryCount: 0,
    generatedTweetUrl: null,
    lastSearchResult: null,
  };
}

const storage = new AsyncLocalStorage<InvocationState>();

// テスト・ALSコンテキスト外用のフォールバック
let fallbackState = createInvocationState();

export function runWithInvocationState<T>(fn: () => T): T {
  return storage.run(createInvocationState(), fn);
}

export function getInvocationState(): InvocationState {
  return storage.getStore() ?? fallbackState;
}

/** フォールバック状態をリセット（テスト用） */
export function resetFallbackState(): void {
  fallbackState = createInvocationState();
}
