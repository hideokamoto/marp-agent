/** Marpスライドエクスポート（PDF/PPTX/HTML/サムネイル生成）— Python版 slide_exporter.py の移植 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// テーマCSSはビルド時に `npm run copy-themes` でランタイムルートに置かれる
// （dist/exports/slideExporter.js からも src/exports/slideExporter.ts からも ../.. がランタイムルート）
const RUNTIME_ROOT = path.resolve(__dirname, '..', '..');

const MARP_TIMEOUT_MS = 120000;

type OutputFormat = 'pdf' | 'pptx' | 'html' | 'png';

/** Marp CLIを実行して出力ファイルのパスを返す（共通処理） */
async function runMarpCli(
  markdown: string,
  outputFormat: OutputFormat,
  theme: string = 'border',
  editable: boolean = false
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'marp-'));
  const mdPath = path.join(dir, 'slide.md');
  const outputPath = path.join(dir, `slide.${outputFormat}`);

  await writeFile(mdPath, markdown, 'utf-8');

  const args = [mdPath, '--allow-local-files', '-o', outputPath];

  if (outputFormat === 'pdf') {
    args.push('--pdf');
  } else if (outputFormat === 'pptx') {
    args.push('--pptx');
    if (editable) args.push('--pptx-editable');
  } else if (outputFormat === 'html') {
    args.push('--html');
  } else if (outputFormat === 'png') {
    args.push('--image', 'png');
  }

  // テーマ設定
  const themePath = path.join(RUNTIME_ROOT, `${theme}.css`);
  if (existsSync(themePath)) {
    args.push('--theme', themePath);
  }

  try {
    await execFileAsync('marp', args, { timeout: MARP_TIMEOUT_MS });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? String(e);
    throw new Error(`Marp CLI error: ${stderr}`);
  }

  return outputPath;
}

/** Marp CLIでPDFを生成 */
export async function generatePdf(markdown: string, theme: string = 'border'): Promise<Buffer> {
  const outputPath = await runMarpCli(markdown, 'pdf', theme);
  return readFile(outputPath);
}

/** Marp CLIでPPTXを生成 */
export async function generatePptx(markdown: string, theme: string = 'border'): Promise<Buffer> {
  const outputPath = await runMarpCli(markdown, 'pptx', theme);
  return readFile(outputPath);
}

/** Marp CLIで編集可能なPPTXを生成（実験的機能、LibreOffice必要） */
export async function generateEditablePptx(markdown: string, theme: string = 'border'): Promise<Buffer> {
  const outputPath = await runMarpCli(markdown, 'pptx', theme, true);
  return readFile(outputPath);
}

/** Marp CLIでスタンドアロンHTMLを生成（共有用） */
export async function generateStandaloneHtml(markdown: string, theme: string = 'border'): Promise<string> {
  const outputPath = await runMarpCli(markdown, 'html', theme);
  return readFile(outputPath, 'utf-8');
}

/** Marp CLIで1枚目のスライドをPNG画像として生成（OGP用サムネイル） */
export async function generateThumbnail(markdown: string, theme: string = 'border'): Promise<Buffer> {
  const outputPath = await runMarpCli(markdown, 'png', theme);

  // Marpは複数スライドの場合 slide.001.png, slide.002.png... を生成
  const dir = path.dirname(outputPath);
  const pngFiles = (await readdir(dir)).filter((f) => f.startsWith('slide') && f.endsWith('.png')).sort();
  if (pngFiles.length === 0) {
    throw new Error('Thumbnail generation failed: no PNG files created');
  }

  return readFile(path.join(dir, pngFiles[0]));
}
