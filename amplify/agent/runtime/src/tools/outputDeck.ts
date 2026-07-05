/** 折衷デッキ出力ツール（HTMLスライドの検証付き）— Python版 output_deck.py の移植 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { getInvocationState } from '../state.js';

export const MAX_DECK_RETRIES = 2;

// セキュリティ上受け入れないパターン（リトライ上限後も拒否する）
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/<\s*script\b/i, 'scriptタグ'],
  [/<\s*iframe\b/i, 'iframeタグ'],
  [/<\s*object\b/i, 'objectタグ'],
  [/<\s*embed\b/i, 'embedタグ'],
  [/\son[a-z]+\s*=/i, 'イベントハンドラ属性（onclick等）'],
  [/javascript\s*:/i, 'javascript: URL'],
];

/** 埋め込み不可のパターンを検出 */
export function checkDeckSecurity(html: string): string[] {
  return FORBIDDEN_PATTERNS.filter(([pattern]) => pattern.test(html)).map(([, label]) => label);
}

function countMatches(html: string, pattern: RegExp): number {
  return (html.match(pattern) ?? []).length;
}

/** デッキ構造の問題を検出（リトライ上限後は警告扱いで受理） */
export function checkDeckStructure(html: string): string[] {
  const problems: string[] = [];

  const divCount = countMatches(html, /<div\s+class="deck-slide"/g);
  const sectionCount = countMatches(html, /<section\b/g);

  if (divCount === 0) {
    problems.push(
      'スライドがありません。各スライドは <div class="deck-slide"><section …>…</section></div> の形で出力してください'
    );
  } else if (sectionCount !== divCount) {
    problems.push(
      `<div class="deck-slide">（${divCount}個）と<section>（${sectionCount}個）の数が一致しません。1スライド = 1つのdeck-slide div + 1つのsection です`
    );
  }

  // data-label / data-speaker-notes はHUD表示とPPTXノートに必須
  const missingLabel = sectionCount - countMatches(html, /<section[^>]*\bdata-label="/g);
  if (sectionCount > 0 && missingLabel > 0) {
    problems.push(`data-label属性のないsectionが${missingLabel}個あります`);
  }
  const missingNotes = sectionCount - countMatches(html, /<section[^>]*\bdata-speaker-notes="/g);
  if (sectionCount > 0 && missingNotes > 0) {
    problems.push(`data-speaker-notes属性のないsectionが${missingNotes}個あります`);
  }

  // SVG markerのidはドキュメント全体で一意でないと矢印が正しく描画されない
  const markerIds = Array.from(html.matchAll(/<marker\s+id="([^"]+)"/g), (m) => m[1]);
  const counts = new Map<string, number>();
  for (const id of markerIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const duplicated = Array.from(counts.entries()).filter(([, c]) => c > 1).map(([id]) => id);
  if (duplicated.length > 0) {
    problems.push(
      `SVGマーカーidが重複しています: ${duplicated.join(', ')}。` +
        '同じ図解テンプレートを複数スライドで使う場合は、2枚目以降のmarker idと' +
        '対応するmarker-end="url(#…)"に連番サフィックスを付けてください（例: fwAh → fwAh-2）'
    );
  }

  return problems;
}

/** ツール本体のロジック（テストから直接呼べるように分離） */
export function executeOutputDeck(slidesHtml: string): string {
  const state = getInvocationState();

  const securityProblems = checkDeckSecurity(slidesHtml);
  if (securityProblems.length > 0) {
    return (
      `使用できない要素が含まれています: ${securityProblems.join(', ')}\n` +
      '該当箇所を削除してから再度 output_deck を呼んでください。'
    );
  }

  const structureProblems = checkDeckStructure(slidesHtml);

  if (structureProblems.length > 0 && state.deckRetryCount < MAX_DECK_RETRIES) {
    state.deckRetryCount += 1;
    const details = structureProblems.map((p) => `  - ${p}`).join('\n');
    return `デッキ構造に問題があります：\n${details}\n修正してから再度 output_deck を呼んでください。`;
  }

  if (structureProblems.length > 0) {
    console.warn(`[WARN] Deck structure: max retries exceeded, accepting with problems: ${JSON.stringify(structureProblems)}`);
  }

  state.generatedSlideSource = slidesHtml;
  state.deckRetryCount = 0;
  return 'スライドを出力しました。';
}

export const outputDeckTool = createTool({
  id: 'output_deck',
  description: `生成した折衷スタイルのスライドHTMLを出力します。スライドを作成・編集したら必ずこのツールで出力してください（テキストで直接書き出さない）。

## 出力フォーマット

- システムプロンプトのテンプレートカタログから各スライドのブロックをコピーし、テキストと数字だけを差し替えたHTMLを出力する
- 全スライドを順番に連結した文字列を渡す。各スライドは \`<div class="deck-slide"><section …>…</section></div>\` の形
- \`<html>\` や \`<body>\` などのページ枠は出力しない（スライドブロックのみ）
- 編集や修正の際も、デッキ全体（全スライド）を毎回出力する

## 必須ルール

- 各sectionの \`data-label\`（短いスライド名）と \`data-speaker-notes\`（実際の発表原稿。定型説明のコピーではなく内容に即したもの）を必ず設定する
- インラインstyle・色・クラス（.mincho/.mono）・要素構造はテンプレート通りに保つ。フォントサイズ縮小や新しい色の追加はしない
- 文字量がテンプレートより多い場合は、文字を小さくするのではなく内容を短くするかスライドを分割する
- 同じ図解テンプレート（14/15/16）を複数枚使う場合、SVGの \`<marker id="…">\` と \`marker-end="url(#…)"\` に連番サフィックスを付けて一意にする
- script/iframe/イベントハンドラ属性などの動的要素は使用禁止（このツールが自動検証）

## 出力後のふるまい

- 出力完了後は一切喋らない。内容の説明・要約・確認メッセージは全て不要
- 検証エラーで修正する時は「スライドの構造に問題があったため修正します」のように、何が起きて何をするか短く伝える`,
  inputSchema: z.object({
    slides_html: z.string().describe('全スライドのHTML（deck-slideブロックを順に連結したもの）'),
  }),
  execute: async ({ context }) => executeOutputDeck(context.slides_html),
});
