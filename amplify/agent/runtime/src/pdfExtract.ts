/** 参考資料PDFのテキスト抽出 — Python版 agent.py の pdfplumber 相当（pdf-parse使用） */

// pdf-parse のパッケージルートはデバッグコードを含むため、実装本体を直接importする
// @ts-expect-error 型定義はパッケージルートにのみ存在する
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

export const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_EXTRACTED_CHARS = 50000; // 約25,000トークン

/** PDFからテキストを抽出 */
export async function extractTextFromPdf(pdfBytes: Buffer): Promise<string> {
  const result = (await pdfParse(pdfBytes)) as { text: string };
  let fullText = result.text.trim();
  if (fullText.length > MAX_EXTRACTED_CHARS) {
    fullText = fullText.slice(0, MAX_EXTRACTED_CHARS) + '\n\n（以降省略）';
  }
  return fullText;
}
