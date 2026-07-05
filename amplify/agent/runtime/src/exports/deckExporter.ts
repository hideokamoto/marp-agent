/** 折衷デッキのエクスポート（HTML組み立て・PNG/PDF/PPTX/サムネイル生成）
 *
 * Python版 deck_exporter.py + render_deck.mjs の移植。
 * ランタイムがNodeになったため、Chromiumレンダリングはサブプロセスではなく
 * playwright-core をインプロセスで使用する。
 */

import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import PptxGenJSImport from 'pptxgenjs';

// pptxgenjs はCJSパッケージのため、NodeNext環境では実行時のdefault二重ラップを解き、
// 型はこのファイルで使う操作だけを定義する
interface PptxSlide {
  addImage(options: { data: string; x: number; y: number; w: number; h: number }): void;
  addNotes(notes: string): void;
}
interface PptxGen {
  defineLayout(options: { name: string; width: number; height: number }): void;
  layout: string;
  title: string;
  addSlide(): PptxSlide;
  write(options: { outputType: string }): Promise<unknown>;
}
const PptxGenJS = (
  (PptxGenJSImport as unknown as { default?: unknown }).default ?? PptxGenJSImport
) as new () => PptxGen;
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/exports からも src/exports からも runtime/decks を指す
const ASSET_DIR = path.resolve(__dirname, '..', '..', 'decks', 'eclectic');

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** スライドソースが折衷デッキ（HTML）かどうかを判定 */
export function isDeckSource(source: string): boolean {
  // 先頭のHTMLコメントをスキップして先頭要素を判定
  const stripped = source.trimStart().replace(/^(<!--[\s\S]*?-->\s*)+/, '');
  return stripped.startsWith('<');
}

/** デッキHTMLからタイトル（最初のh1/h2のテキスト）を抽出 */
export function extractDeckTitle(slidesHtml: string): string | null {
  const match = slidesHtml.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/);
  if (!match) return null;
  let text = match[1].replace(/<br\s*\/?>/g, ' ');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
  return text || null;
}

/** スライドブロックをシェルに埋め込み、CSS/JSをインライン化した単一HTMLを返す */
export function assembleDeckHtml(slidesHtml: string, title?: string | null, subtitle: string = ''): string {
  const shell = readFileSync(path.join(ASSET_DIR, 'deck-shell.html'), 'utf-8');
  const css = readFileSync(path.join(ASSET_DIR, 'deck.css'), 'utf-8');
  const js = readFileSync(path.join(ASSET_DIR, 'deck.js'), 'utf-8');

  const resolvedTitle = title || extractDeckTitle(slidesHtml) || 'スライド';
  let html = shell.replace('{{DECK_TITLE}}', escapeHtml(resolvedTitle));
  html = html.replace('{{DECK_SUBTITLE}}', escapeHtml(subtitle));

  // 外部参照をインライン化して自己完結型の1ファイルにする（共有・レンダリング両用）
  html = html.replace('<link rel="stylesheet" href="deck.css">', `<style>\n${css}\n</style>`);
  html = html.replace('<script src="deck.js"></script>', `<script>\n${js}\n</script>`);

  const startMarker = '<!-- SLIDES:START -->';
  const endMarker = '<!-- SLIDES:END -->';
  const start = html.indexOf(startMarker) + startMarker.length;
  const end = html.indexOf(endMarker);
  return html.slice(0, start) + '\n' + slidesHtml + '\n' + html.slice(end);
}

function findChromium(): string {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error('Chromium not found (set PUPPETEER_EXECUTABLE_PATH).');
}

export interface SlideNote {
  index: number;
  label: string;
  notes: string;
}

interface RenderResult {
  pngs: Buffer[];
  notes: SlideNote[];
}

/** デッキをChromiumでレンダリングし、各スライドのPNGとノート情報を返す */
async function renderDeckPngs(slidesHtml: string, scale: number = 2, limit?: number): Promise<RenderResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-'));
  const deckPath = path.join(dir, 'deck.html');
  await writeFile(deckPath, assembleDeckHtml(slidesHtml), 'utf-8');

  // AgentCoreコンテナはroot実行のためsandboxを無効化
  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width: DESIGN_WIDTH, height: DESIGN_HEIGHT },
      deviceScaleFactor: scale,
    });
    await page
      .goto(pathToFileURL(deckPath).href, { waitUntil: 'networkidle' })
      .catch((e) => console.warn(`[WARN] Deck navigation issue: ${e.message}`));
    // Webフォント（Shippori Mincho等）の読み込みを待つ。オフライン時はフォールバックで続行
    await page.waitForTimeout(600);
    await page
      .evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready)
      .catch((e) => console.warn(`[WARN] Font wait failed: ${e}`));

    // キャプチャ用にフラット化: フィットスケールを無効化し、プレゼン用UIを隠し、
    // スライドを1枚ずつ表示する
    await page.addStyleTag({
      content: `
      #stage-scaler{position:absolute!important;left:0!important;top:0!important;
        transform:none!important;width:${DESIGN_WIDTH}px!important;height:${DESIGN_HEIGHT}px!important;}
      .deck-slide{position:absolute!important;inset:0!important;display:none!important;}
      .deck-slide.__cap{display:block!important;}
      .progress,.hud,.notes,.overview,.help{display:none!important;}
      html,body{background:#F5F2EC!important;overflow:hidden!important;}
    `,
    });

    const slideCount = await page.locator('.deck-slide').count();
    if (slideCount === 0) {
      throw new Error('No .deck-slide elements found — the deck failed to load.');
    }
    const total = limit !== undefined ? Math.min(slideCount, limit) : slideCount;

    const pngs: Buffer[] = [];
    const notes: SlideNote[] = [];

    for (let i = 0; i < total; i++) {
      const info = await page.evaluate((idx) => {
        const all = document.querySelectorAll('.deck-slide');
        all.forEach((el, k) => el.classList.toggle('__cap', k === idx));
        const sec = all[idx].querySelector('section') as HTMLElement | null;
        return {
          label: sec?.dataset.label ?? '',
          notes: sec?.dataset.speakerNotes ?? '',
        };
      }, i);
      await page.waitForTimeout(120);
      const png = await page.screenshot({
        clip: { x: 0, y: 0, width: DESIGN_WIDTH, height: DESIGN_HEIGHT },
      });
      pngs.push(png);
      notes.push({ index: i + 1, label: info.label, notes: info.notes });
    }

    return { pngs, notes };
  } finally {
    await browser.close();
  }
}

/** 折衷デッキをPPTXに変換（全面画像スライド＋スピーカーノート） */
export async function generateDeckPptx(slidesHtml: string, title?: string | null): Promise<Buffer> {
  const { pngs, notes } = await renderDeckPngs(slidesHtml);

  const pptx = new PptxGenJS();
  // 1920×1080のデザインに合わせた16:9キャンバス（13.333in × 7.5in）
  pptx.defineLayout({ name: 'DECK_16x9', width: 13.333, height: 7.5 });
  pptx.layout = 'DECK_16x9';
  pptx.title = title || extractDeckTitle(slidesHtml) || 'スライド';

  pngs.forEach((png, i) => {
    const slide = pptx.addSlide();
    slide.addImage({
      data: `image/png;base64,${png.toString('base64')}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: 7.5,
    });
    const meta = notes[i];
    if (meta?.notes) {
      slide.addNotes((meta.label ? `[${meta.label}] ` : '') + meta.notes);
    }
  });

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}

/** 折衷デッキをPDFに変換（レンダリング済みPNGを結合） */
export async function generateDeckPdf(slidesHtml: string): Promise<Buffer> {
  const { pngs } = await renderDeckPngs(slidesHtml);

  const doc = await PDFDocument.create();
  for (const png of pngs) {
    const image = await doc.embedPng(png);
    const page = doc.addPage([DESIGN_WIDTH, DESIGN_HEIGHT]);
    page.drawImage(image, { x: 0, y: 0, width: DESIGN_WIDTH, height: DESIGN_HEIGHT });
  }
  return Buffer.from(await doc.save());
}

/** 折衷デッキの1枚目をPNGで生成（OGP用サムネイル） */
export async function generateDeckThumbnail(slidesHtml: string): Promise<Buffer> {
  const { pngs } = await renderDeckPngs(slidesHtml, 1, 1);
  return pngs[0];
}

/** 折衷デッキのスタンドアロンHTMLを生成（共有用） */
export function generateDeckStandaloneHtml(slidesHtml: string, title?: string | null): string {
  return assembleDeckHtml(slidesHtml, title);
}
