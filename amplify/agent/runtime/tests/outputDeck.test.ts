/** output_deck ツールと deckExporter のユニットテスト — Python版 test_output_deck.py の移植 */
import { describe, it, expect, beforeEach } from 'vitest';
import { executeOutputDeck, MAX_DECK_RETRIES } from '../src/tools/outputDeck.js';
import { getInvocationState, resetFallbackState } from '../src/state.js';
import { isDeckSource, extractDeckTitle, assembleDeckHtml } from '../src/exports/deckExporter.js';

function validDeck(markerSuffix: string = ''): string {
  return `<div class="deck-slide">
  <section data-label="タイトル" data-speaker-notes="表紙の説明" style="background:#F5F2EC;">
    <h1 class="mincho">テスト<br>スライド</h1>
    <svg><defs><marker id="ah${markerSuffix}"></marker></defs></svg>
  </section>
</div>`;
}

beforeEach(() => {
  resetFallbackState();
});

describe('output_deck の検証と保存', () => {
  it('正常なデッキHTMLは保存される', () => {
    const deck = validDeck();
    expect(executeOutputDeck(deck)).toBe('スライドを出力しました。');
    expect(getInvocationState().generatedSlideSource).toBe(deck);
  });

  it('scriptタグは拒否される（リトライ後も受理しない）', () => {
    const deck = validDeck() + '<script>alert(1)</script>';
    for (let i = 0; i < MAX_DECK_RETRIES + 2; i++) {
      expect(executeOutputDeck(deck)).toContain('使用できない要素');
    }
    expect(getInvocationState().generatedSlideSource).toBeNull();
  });

  it('イベントハンドラ属性は拒否される', () => {
    const deck = validDeck().replace('<section ', '<section onclick="x()" ');
    expect(executeOutputDeck(deck)).toContain('使用できない要素');
    expect(getInvocationState().generatedSlideSource).toBeNull();
  });

  it('deck-slideラッパーがないと構造エラー', () => {
    const result = executeOutputDeck('<section data-label="a" data-speaker-notes="b"></section>');
    expect(result).toContain('デッキ構造に問題');
    expect(getInvocationState().generatedSlideSource).toBeNull();
  });

  it('data-label / data-speaker-notes の欠落を検出', () => {
    const deck = '<div class="deck-slide"><section style="background:#F5F2EC;"></section></div>';
    const result = executeOutputDeck(deck);
    expect(result).toContain('data-label');
    expect(result).toContain('data-speaker-notes');
  });

  it('SVGマーカーidの重複を検出', () => {
    const deck = validDeck() + validDeck();
    const result = executeOutputDeck(deck);
    expect(result).toContain('マーカーid');
    expect(getInvocationState().generatedSlideSource).toBeNull();
  });

  it('サフィックスで一意になったマーカーidは受理', () => {
    const deck = validDeck() + validDeck('-2');
    expect(executeOutputDeck(deck)).toBe('スライドを出力しました。');
  });

  it('構造の問題はリトライ上限後に警告付きで受理される', () => {
    const deck = '<div class="deck-slide"><section style="background:#F5F2EC;"></section></div>';
    for (let i = 0; i < MAX_DECK_RETRIES; i++) {
      expect(executeOutputDeck(deck)).toContain('デッキ構造に問題');
    }
    expect(executeOutputDeck(deck)).toBe('スライドを出力しました。');
    expect(getInvocationState().generatedSlideSource).toBe(deck);
  });
});

describe('deckExporter の形式判定・タイトル抽出・HTML組み立て', () => {
  it('isDeckSourceはHTMLを検出する', () => {
    expect(isDeckSource(validDeck())).toBe(true);
    expect(isDeckSource('  \n<!-- コメント -->\n<div class="deck-slide">')).toBe(true);
  });

  it('isDeckSourceはMarpマークダウンを検出しない', () => {
    expect(isDeckSource('---\nmarp: true\n---\n# タイトル')).toBe(false);
    expect(isDeckSource('# タイトル\n\n- 箇条書き')).toBe(false);
  });

  it('extractDeckTitleはタグを除去する', () => {
    expect(extractDeckTitle(validDeck())).toBe('テスト スライド');
  });

  it('extractDeckTitleは見出しがなければnull', () => {
    expect(extractDeckTitle('<div class="deck-slide"><section></section></div>')).toBeNull();
  });

  it('assembleDeckHtmlはスライドとタイトルを埋め込む', () => {
    const deck = validDeck();
    const html = assembleDeckHtml(deck);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain(deck);
    expect(html).toContain('<title>テスト スライド</title>');
    // CSS/JSがインライン化され、外部参照が残っていない
    expect(html).not.toContain('href="deck.css"');
    expect(html).not.toContain('src="deck.js"');
    expect(html).toContain('#stage-scaler'); // deck.cssの内容
    expect(html).toContain('deckdeck'); // deck.jsの内容
  });

  it('assembleDeckHtmlはタイトルをエスケープする', () => {
    const html = assembleDeckHtml('<div class="deck-slide"><section></section></div>', '<b>悪意&タイトル</b>');
    expect(html).toContain('<title>&lt;b&gt;悪意&amp;タイトル&lt;/b&gt;</title>');
  });
});
