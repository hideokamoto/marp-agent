/** セッション管理・ツイートURL・HTMLテキスト抽出のユニットテスト */
import { describe, it, expect, beforeEach } from 'vitest';
import { sessionKey, getHistory, appendExchange, clearSessions } from '../src/sessionManager.js';
import { executeGenerateTweetUrl } from '../src/tools/generateTweet.js';
import { htmlToText } from '../src/tools/httpRequest.js';
import { getInvocationState, resetFallbackState } from '../src/state.js';
import { getSystemPrompt, getModelConfig } from '../src/config.js';

beforeEach(() => {
  resetFallbackState();
  clearSessions();
});

describe('sessionManager', () => {
  it('セッションIDがなければキーはnull（履歴なし）', () => {
    expect(sessionKey(null, 'sonnet', 'border')).toBeNull();
    expect(getHistory(null)).toEqual([]);
  });

  it('モデル・テーマ切り替えで別履歴になる', () => {
    expect(sessionKey('s1', 'sonnet', 'border')).not.toBe(sessionKey('s1', 'opus', 'border'));
    expect(sessionKey('s1', 'sonnet', 'border')).not.toBe(sessionKey('s1', 'sonnet', 'eclectic'));
  });

  it('やり取りを追加すると履歴に残る', () => {
    const key = sessionKey('s1', 'sonnet', 'border');
    appendExchange(key, 'こんにちは', 'どうも');
    const history = getHistory(key);
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: 'user', content: 'こんにちは' });
    expect(history[1]).toEqual({ role: 'assistant', content: 'どうも' });
  });

  it('ウィンドウサイズ（6）を超えた古いメッセージは削除される', () => {
    const key = sessionKey('s1', 'sonnet', 'border');
    for (let i = 0; i < 5; i++) {
      appendExchange(key, `user${i}`, `assistant${i}`);
    }
    const history = getHistory(key);
    expect(history).toHaveLength(6);
    expect(history[0].content).toBe('user2'); // 古いものから消える
  });
});

describe('generate_tweet_url', () => {
  it('日本語をURLエンコードしたIntent URLを生成する', () => {
    const result = executeGenerateTweetUrl('#パワポ作るマン テスト');
    expect(result).toBe('ツイートURLを生成しました。');
    const url = getInvocationState().generatedTweetUrl!;
    expect(url).toMatch(/^https:\/\/twitter\.com\/intent\/tweet\?text=/);
    expect(url).toContain(encodeURIComponent('#パワポ作るマン テスト'));
  });
});

describe('htmlToText', () => {
  it('script/styleタグを除去してテキスト抽出', () => {
    const html = '<html><head><style>body{}</style><script>x()</script></head><body><h1>見出し</h1><p>本文</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('見出し');
    expect(text).toContain('本文');
    expect(text).not.toContain('x()');
    expect(text).not.toContain('body{}');
  });
});

describe('config', () => {
  it('モデル設定: opusとsonnet（デフォルト）', () => {
    expect(getModelConfig('opus').modelId).toContain('opus');
    expect(getModelConfig().modelId).toContain('sonnet');
    expect(getModelConfig('unknown').modelId).toContain('sonnet');
  });

  it('Marpテーマのプロンプトにはテーマ名が入る', () => {
    expect(getSystemPrompt('border')).toContain('theme: border');
  });

  it('折衷テーマのプロンプトにはテンプレートブロックが含まれる', () => {
    const prompt = getSystemPrompt('eclectic');
    expect(prompt).toContain('output_deck');
    expect(prompt).toContain('deck-slide'); // slide-blocks.html の内容
    expect(prompt).toContain('#F5F2EC');
    expect(prompt.length).toBeGreaterThan(30000); // 17ブロック込み
  });
});
