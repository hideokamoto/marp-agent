/** スライド出力ツール（ページあふれチェック付き）— Python版 output_slide.py の移植 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { eastAsianWidth } from 'get-east-asian-width';
import { getInvocationState } from '../state.js';

export const MAX_OVERFLOW_RETRIES = 2;
export const MAX_LINES_PER_SLIDE = 9;
// 1行あたりの最大表示幅（半角換算）
// Marp 16:9スライドでの実測値: 箇条書き行で半角約54文字分で折り返し発生
// 安全マージンとして全角3文字分（半角6）を引いた値
export const MAX_DISPLAY_WIDTH_PER_LINE = 48;
// テーブル行の最大表示幅（半角換算）
// テーブルはテキスト折り返しされず横にはみ出すため、行全体の幅をチェック
export const MAX_TABLE_ROW_WIDTH = 64;

/** テキストの表示幅を半角換算で計算（全角=2, 半角=1。曖昧幅Aは日本語環境準拠で全角扱い） */
export function getDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += eastAsianWidth(char.codePointAt(0)!, { ambiguousAsWide: true });
  }
  return width;
}

/** マークダウンの装飾記法を除去して表示テキストを取得 */
export function stripMarkdownFormatting(text: string): string {
  let t = text;
  // 太字/斜体（** __ * _）
  t = t.replace(/\*\*(.+?)\*\*/g, '$1');
  t = t.replace(/__(.+?)__/g, '$1');
  t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1');
  t = t.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '$1');
  // 取り消し線
  t = t.replace(/~~(.+?)~~/g, '$1');
  // インラインコード
  t = t.replace(/`(.+?)`/g, '$1');
  // リンク [text](url) → text
  t = t.replace(/\[(.+?)\]\(.+?\)/g, '$1');
  // 箇条書きマーカー
  t = t.replace(/^[-*+]\s+/, '');
  // 番号付きリスト
  t = t.replace(/^\d+\.\s+/, '');
  // 見出し
  t = t.replace(/^#{1,6}\s+/, '');
  // 引用
  t = t.replace(/^>\s*/, '');
  return t;
}

/** テキスト1行の表示幅から実質的な行数（折り返し考慮）を推定 */
export function estimateVisualLines(text: string): number {
  // テーブル行はセル幅の計算が複雑なため折り返し計算対象外
  const stripped = text.trim();
  if (stripped.startsWith('|') && stripped.endsWith('|')) {
    return 1;
  }
  const displayText = stripMarkdownFormatting(stripped);
  const width = getDisplayWidth(displayText);
  if (width <= MAX_DISPLAY_WIDTH_PER_LINE) {
    return 1;
  }
  return Math.ceil(width / MAX_DISPLAY_WIDTH_PER_LINE);
}

/** Marpマークダウンをスライドごとに分割（フロントマター除外） */
export function parseSlides(markdown: string): string[] {
  const content = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
  const slides = content.split(/\n---\s*\n/);
  return slides.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** スライド内のコンテンツ行数をカウント（折り返し考慮） */
export function countContentLines(slideContent: string): number {
  const lines = slideContent.split('\n');
  let count = 0;
  let inCodeBlock = false;

  for (const line of lines) {
    const stripped = line.trim();

    // コードブロック開始/終了（マーカー自体はカウントしない）
    if (stripped.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (!stripped) continue; // 空行スキップ
    if (/^<!--.*-->$/.test(stripped)) continue; // HTMLコメントスキップ
    if (/^\|[\s\-:|]+\|$/.test(stripped)) continue; // 表セパレーター行スキップ

    // 折り返しを考慮した実質行数を加算
    count += estimateVisualLines(stripped);
  }

  return count;
}

/** テーブル行の横幅をチェックし、最大幅を返す（超過なしなら0） */
export function checkTableWidth(slideContent: string): number {
  let maxWidth = 0;
  for (const line of slideContent.split('\n')) {
    const stripped = line.trim();
    if (!(stripped.startsWith('|') && stripped.endsWith('|'))) continue;
    // セパレーター行はスキップ
    if (/^\|[\s\-:|]+\|$/.test(stripped)) continue;
    const width = getDisplayWidth(stripped);
    if (width > MAX_TABLE_ROW_WIDTH) {
      maxWidth = Math.max(maxWidth, width);
    }
  }
  return maxWidth;
}

export interface SlideViolation {
  slideNumber: number;
  type: 'line_overflow' | 'table_overflow';
  lineCount?: number;
  maxWidth?: number;
  excess: number;
}

/** 各スライドの行数・テーブル横幅をチェックし、制限超過スライドの情報を返す */
export function checkSlideOverflow(markdown: string): SlideViolation[] {
  const slides = parseSlides(markdown);
  const violations: SlideViolation[] = [];

  slides.forEach((slide, i) => {
    // 特殊スライド（top, lead, end, tinytext）はスキップ
    if (/_class:\s*(top|lead|end|tinytext)/.test(slide)) return;

    // 行数チェック（縦方向）
    const lineCount = countContentLines(slide);
    if (lineCount > MAX_LINES_PER_SLIDE) {
      violations.push({
        slideNumber: i + 1,
        type: 'line_overflow',
        lineCount,
        excess: lineCount - MAX_LINES_PER_SLIDE,
      });
    }

    // テーブル横幅チェック
    const tableMaxWidth = checkTableWidth(slide);
    if (tableMaxWidth > 0) {
      violations.push({
        slideNumber: i + 1,
        type: 'table_overflow',
        maxWidth: tableMaxWidth,
        excess: tableMaxWidth - MAX_TABLE_ROW_WIDTH,
      });
    }
  });

  return violations;
}

/** ツール本体のロジック（テストから直接呼べるように分離） */
export function executeOutputSlide(markdown: string): string {
  const state = getInvocationState();
  const violations = checkSlideOverflow(markdown);

  if (violations.length > 0 && state.slideOverflowRetryCount < MAX_OVERFLOW_RETRIES) {
    state.slideOverflowRetryCount += 1;
    const details = violations.map((v) =>
      v.type === 'line_overflow'
        ? `  - スライド${v.slideNumber}: 実質${v.lineCount}行（${v.excess}行超過）`
        : `  - スライド${v.slideNumber}: 表の横幅超過（${v.maxWidth}文字、上限${MAX_TABLE_ROW_WIDTH}文字）`
    );
    return (
      `あふれ検出！以下のスライドに問題があります：\n${details.join('\n')}\n` +
      '修正してから再度 output_slide を呼んでください。' +
      '（行数超過→内容を減らすか分割。表の横幅超過→列数を減らすかセル内容を短くする）'
    );
  }

  if (violations.length > 0) {
    console.warn(`[WARN] Slide overflow: max retries exceeded, accepting with violations: ${JSON.stringify(violations)}`);
  }

  state.generatedSlideSource = markdown;
  state.slideOverflowRetryCount = 0;
  return 'スライドを出力しました。';
}

export const outputSlideTool = createTool({
  id: 'output_slide',
  description: `生成したスライドのマークダウンを出力します。スライドを作成・編集したら必ずこのツールを使って出力してください（テキストで直接書き出さない）。

## Marpフォーマットルール

- フロントマター: \`marp: true\`, \`theme: {テーマ名}\`, \`size: 16:9\`, \`paginate: true\`
- スライド区切り: \`---\`
- 1枚目はタイトルスライド（\`<!-- _class: top --><!-- _paginate: skip -->\`付き、テキスト中央揃え）
- **1スライドの行数**: 見出し＋本文すべて合わせて7〜8行を目標（9行が上限、このツールが自動検証）。3〜4行で終わらせない。1行が長いと折り返しで実質2行になるため、全角24文字（半角48文字）程度に抑える
- **絵文字は使用禁止**（自動改行でレイアウト崩れ）
- ==ハイライト==記法は使用禁止（日本語と相性悪い）

## 構成テクニック

- **セクション区切り【必須】**: 3〜4枚ごとに \`<!-- _class: lead -->\` の中タイトルスライドを挿入
- **スライドの表現パターン【重要】**: 同じパターンが2枚連続しないよう、以下A〜Eをローテーションする:
  - A. **箇条書き型**: \`##\` + 箇条書き5〜6項目
  - B. **小見出し型**: \`##\` + \`###\` + 説明文2〜3行 + 箇条書き2〜3項目
  - C. **テーブル型**: \`##\` + リード文1行 + 2〜3列テーブル（セル内容は全角10文字以内。横幅もこのツールが自動検証）
  - D. **本文+箇条書き型**: \`##\` + 説明文1〜2行 + 箇条書き4〜5項目
  - E. **まとめ型**: \`##\` + 箇条書き3〜4項目 + \`**太字のワンライナーまとめ**\`
- **箇条書きスタイル**: 太字は使用OK。日本語テキストでコロンを使う場合は半角（:）ではなく全角（：）にする
- **出典スライド**: Web検索時は最後に \`<!-- _class: tinytext -->\` 付きの参考文献スライドを追加
- **裏表紙【必須】**: 最後のスライドは \`<!-- _class: end --><!-- _paginate: skip -->\` を付けて「Thank you!」とだけ表示

## 出力後のふるまい

- 出力完了後は一切喋らない。内容の説明・要約・確認メッセージは全て不要
- ページあふれ修正時は「○ページ目の文字量がはみ出していたため、内容を調整します」のように、何が起きて何をするか分かりやすく伝える`,
  inputSchema: z.object({
    markdown: z.string().describe('Marp形式のマークダウン全文（フロントマターを含む）'),
  }),
  execute: async ({ context }) => executeOutputSlide(context.markdown),
});
