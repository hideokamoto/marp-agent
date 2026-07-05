/** output_slide ツールのユニットテスト — Python版 test_output_slide.py の移植 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  executeOutputSlide,
  getDisplayWidth,
  stripMarkdownFormatting,
  estimateVisualLines,
  parseSlides,
  countContentLines,
  checkSlideOverflow,
  MAX_LINES_PER_SLIDE,
  MAX_DISPLAY_WIDTH_PER_LINE,
} from '../src/tools/outputSlide.js';
import { getInvocationState, resetFallbackState } from '../src/state.js';

beforeEach(() => {
  resetFallbackState();
});

describe('output_slide の基本動作', () => {
  it('マークダウンを保存する', () => {
    const markdown = '---\nmarp: true\n---\n# テスト';
    const result = executeOutputSlide(markdown);
    expect(result).toBe('スライドを出力しました。');
    expect(getInvocationState().generatedSlideSource).toBe(markdown);
  });

  it('初期状態ではnull', () => {
    expect(getInvocationState().generatedSlideSource).toBeNull();
  });

  it('連続呼び出しで最新のマークダウンが保持される', () => {
    executeOutputSlide('# first');
    executeOutputSlide('# second');
    expect(getInvocationState().generatedSlideSource).toBe('# second');
  });
});

describe('getDisplayWidth', () => {
  it('半角英数字のみ', () => {
    expect(getDisplayWidth('Hello')).toBe(5);
  });

  it('全角文字のみ', () => {
    expect(getDisplayWidth('こんにちは')).toBe(10);
  });

  it('全角・半角混在', () => {
    expect(getDisplayWidth('ABCあいう')).toBe(9);
  });

  it('実際にはみ出した長い日本語スライド行', () => {
    const text = '2022年設立、企業グループのDX推進専門会社（母体は2016年発足の事業組織）';
    expect(getDisplayWidth(text)).toBeGreaterThan(MAX_DISPLAY_WIDTH_PER_LINE);
  });

  it('短い箇条書き（折り返し不要）', () => {
    expect(getDisplayWidth('短い項目')).toBeLessThanOrEqual(MAX_DISPLAY_WIDTH_PER_LINE);
  });
});

describe('stripMarkdownFormatting', () => {
  it('太字の除去', () => {
    expect(stripMarkdownFormatting('**太字**テスト')).toBe('太字テスト');
  });

  it('斜体の除去', () => {
    expect(stripMarkdownFormatting('*斜体*テスト')).toBe('斜体テスト');
  });

  it('箇条書きマーカーの除去', () => {
    expect(stripMarkdownFormatting('- 箇条書き')).toBe('箇条書き');
  });

  it('見出しマーカーの除去', () => {
    expect(stripMarkdownFormatting('## 見出し')).toBe('見出し');
  });

  it('リンクのURL除去', () => {
    expect(stripMarkdownFormatting('[テキスト](https://example.com)')).toBe('テキスト');
  });

  it('インラインコードのバッククォート除去', () => {
    expect(stripMarkdownFormatting('`code`テスト')).toBe('codeテスト');
  });

  it('複合装飾', () => {
    expect(stripMarkdownFormatting('- **2022年設立**、企業グループ')).toBe('2022年設立、企業グループ');
  });

  it('引用マーカーの除去', () => {
    expect(stripMarkdownFormatting('> 引用テキスト')).toBe('引用テキスト');
  });
});

describe('estimateVisualLines', () => {
  it('短い行は1行', () => {
    expect(estimateVisualLines('- 短い項目')).toBe(1);
  });

  it('長い日本語行は折り返しで2行以上', () => {
    const longText = '- **2022年設立**、企業グループのDX推進専門会社（母体は2016年発足の事業組織）';
    expect(estimateVisualLines(longText)).toBeGreaterThanOrEqual(2);
  });

  it('テーブル行は折り返し計算対象外（常に1行）', () => {
    expect(
      estimateVisualLines('| 長い長い長い長い長い長い長い長いテキスト | 長い長い長い長い長い長い長い長いテキスト |')
    ).toBe(1);
  });

  it('短い見出しは1行', () => {
    expect(estimateVisualLines('## 短い見出し')).toBe(1);
  });
});

describe('parseSlides', () => {
  it('フロントマター付きの基本的なスライド分割', () => {
    const md = '---\nmarp: true\ntheme: border\n---\n\n## Slide 1\n\n- Item 1\n\n---\n\n## Slide 2\n\n- Item 2';
    const slides = parseSlides(md);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toContain('Slide 1');
    expect(slides[1]).toContain('Slide 2');
  });

  it('フロントマターなしのマークダウン', () => {
    const md = '## Slide 1\n\n- Item 1\n\n---\n\n## Slide 2';
    expect(parseSlides(md).length).toBeGreaterThanOrEqual(1);
  });

  it('空のマークダウン', () => {
    expect(parseSlides('')).toEqual([]);
  });
});

describe('countContentLines', () => {
  it('見出し+箇条書きの基本カウント（短い行）', () => {
    expect(countContentLines('## タイトル\n\n- 項目1\n- 項目2\n- 項目3')).toBe(4);
  });

  it('空行はカウントしない', () => {
    expect(countContentLines('## タイトル\n\n\n\n- 項目1')).toBe(2);
  });

  it('HTMLコメントはカウントしない', () => {
    expect(countContentLines('<!-- _class: lead -->\n## タイトル\n- 項目1')).toBe(2);
  });

  it('表のセパレーター行はカウントしない', () => {
    expect(countContentLines('## 比較表\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |')).toBe(4);
  });

  it('コードブロック内の行はカウントする', () => {
    expect(countContentLines("## コード例\n\n```python\nprint('hello')\nprint('world')\n```")).toBe(3);
  });

  it('```マーカー自体はカウントしない', () => {
    expect(countContentLines('```\nline1\n```')).toBe(1);
  });

  it('ちょうど9行のスライド（短い行）', () => {
    const lines = ['## 見出し', ...Array.from({ length: 8 }, (_, i) => `- 項目${i + 1}`)];
    expect(countContentLines(lines.join('\n'))).toBe(9);
  });

  it('引用ブロックの行もカウント', () => {
    expect(countContentLines('## 引用\n\n> 引用文1\n> 引用文2')).toBe(3);
  });

  it('アライメント付き表セパレーターもスキップ', () => {
    expect(countContentLines('| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |')).toBe(2);
  });

  it('長い行は折り返しで複数行としてカウント', () => {
    const longBullet = '- **2022年設立**、企業グループのDX推進専門会社（母体は2016年発足の事業組織）';
    const content = `## DX支援会社とは\n\n${longBullet}\n- 短い項目\n- 短い項目2`;
    expect(countContentLines(content)).toBeGreaterThan(4);
  });
});

const OVERFLOW_SLIDE_BY_LONG_LINES = [
  '## DX支援会社とは？',
  '',
  '> TRANSFORM YOUR BUSINESS',
  '',
  '- **2022年設立**、企業グループのDX推進専門会社（母体は2016年発足の事業組織）',
  '- 全社員がアジャイル認定資格を保有、経営層を含む全員がスクラムの実践者',
  '- 「サービスデザイン」「アジャイル開発」「クラウドネイティブ」の3本柱でDXを一貫支援',
  '- 開発期間1/2・コスト1/3を実現した実績（エネルギー系アプリ開発事例）',
  '- 高輪ゲートウェイシティ都市OS開発など、社会インフラ規模のプロジェクトも担う',
].join('\n');

describe('checkSlideOverflow', () => {
  it('全スライド9行以内 → 違反なし', () => {
    const md = '---\nmarp: true\n---\n\n## Slide 1\n\n- Item 1\n- Item 2\n\n---\n\n## Slide 2\n\n- Item 1';
    expect(checkSlideOverflow(md)).toEqual([]);
  });

  it('10行のスライド → 違反検出', () => {
    const lines = ['## 見出し', ...Array.from({ length: 9 }, (_, i) => `- 項目${i + 1}`)];
    const md = `---\nmarp: true\n---\n\n${lines.join('\n')}`;
    const violations = checkSlideOverflow(md);
    expect(violations).toHaveLength(1);
    expect(violations[0].lineCount).toBe(10);
    expect(violations[0].excess).toBe(1);
  });

  it('行数は少ないが長い行の折り返しで超過するケース', () => {
    const md = `---\nmarp: true\n---\n\n${OVERFLOW_SLIDE_BY_LONG_LINES}`;
    const violations = checkSlideOverflow(md);
    expect(violations).toHaveLength(1);
    expect(violations[0].lineCount!).toBeGreaterThan(MAX_LINES_PER_SLIDE);
  });

  const specialClasses = ['top', 'lead', 'end', 'tinytext'];
  for (const cls of specialClasses) {
    it(`特殊スライド（_class: ${cls}）はスキップ`, () => {
      const lines = [`<!-- _class: ${cls} -->`, '## タイトル', ...Array.from({ length: 14 }, (_, i) => `- 項目${i + 1}`)];
      const md = `---\nmarp: true\n---\n\n${lines.join('\n')}`;
      expect(checkSlideOverflow(md)).toEqual([]);
    });
  }

  it('複数スライドが超過', () => {
    const slide1 = ['## S1', ...Array.from({ length: 10 }, (_, i) => `- 項目${i + 1}`)].join('\n');
    const slide2 = ['## S2', ...Array.from({ length: 11 }, (_, i) => `- 項目${i + 1}`)].join('\n');
    const md = `---\nmarp: true\n---\n\n${slide1}\n\n---\n\n${slide2}`;
    expect(checkSlideOverflow(md)).toHaveLength(2);
  });
});

describe('output_slide のバリデーション統合', () => {
  const overflowMd = () => {
    const lines = ['## 見出し', ...Array.from({ length: 10 }, (_, i) => `- 項目${i + 1}`)];
    return `---\nmarp: true\n---\n\n${lines.join('\n')}`;
  };

  it('9行以内のスライドは正常出力', () => {
    const md = '---\nmarp: true\n---\n\n## Title\n\n- Item 1\n- Item 2\n- Item 3';
    expect(executeOutputSlide(md)).toBe('スライドを出力しました。');
    expect(getInvocationState().generatedSlideSource).toBe(md);
  });

  it('超過スライドは1回目・2回目リジェクト、3回目は警告付きで受け入れ', () => {
    const md = overflowMd();
    expect(executeOutputSlide(md)).toContain('あふれ検出');
    expect(getInvocationState().generatedSlideSource).toBeNull();
    expect(executeOutputSlide(md)).toContain('あふれ検出');
    expect(getInvocationState().generatedSlideSource).toBeNull();
    expect(executeOutputSlide(md)).toBe('スライドを出力しました。');
    expect(getInvocationState().generatedSlideSource).toBe(md);
  });

  it('正常出力後にリトライカウンターがリセットされる', () => {
    executeOutputSlide('---\nmarp: true\n---\n\n## Title\n\n- Item 1');
    expect(executeOutputSlide(overflowMd())).toContain('あふれ検出');
  });

  it('状態リセットでリトライカウンターもリセット', () => {
    const md = overflowMd();
    executeOutputSlide(md);
    executeOutputSlide(md);
    resetFallbackState();
    expect(executeOutputSlide(md)).toContain('あふれ検出');
  });

  it('折り返しによる超過もリジェクトされる', () => {
    const md = `---\nmarp: true\n---\n\n${OVERFLOW_SLIDE_BY_LONG_LINES}`;
    expect(executeOutputSlide(md)).toContain('あふれ検出');
  });
});
