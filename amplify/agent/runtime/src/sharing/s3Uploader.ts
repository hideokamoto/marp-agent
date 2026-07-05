/** スライド共有（S3アップロード・OGP生成）— Python版 s3_uploader.py の移植 */

import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { generateStandaloneHtml, generateThumbnail } from '../exports/slideExporter.js';
import {
  isDeckSource,
  extractDeckTitle,
  generateDeckStandaloneHtml,
  generateDeckThumbnail,
} from '../exports/deckExporter.js';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (s3Client === null) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

/** テスト用: S3クライアントを差し替える */
export function setS3ClientForTesting(client: S3Client | null): void {
  s3Client = client;
}

/** マークダウンからスライドタイトルを抽出 */
export function extractSlideTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** HTMLにOGPメタタグを挿入（既存のOGP/Twitterタグは削除して置換） */
export function injectOgpTags(html: string, title: string, imageUrl: string, pageUrl: string): string {
  const safeTitle = escapeHtml(title);

  // Marp CLIが生成する既存のOGP/Twitterタグを削除（重複防止）
  let result = html.replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/g, '');
  result = result.replace(/<meta\s+name="twitter:[^"]*"[^>]*>\s*/g, '');

  const ogpTags = `
    <meta property="og:title" content="${safeTitle}">
    <meta property="og:type" content="website">
    <meta property="og:url" content="${pageUrl}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:description" content="パワポ作るマンで作成したスライド">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${safeTitle}">
    <meta name="twitter:image" content="${imageUrl}">
    `;
  // </head>の前にOGPタグを挿入
  return result.replace('</head>', `${ogpTags}</head>`);
}

export interface ShareResult {
  slideId: string;
  url: string;
  expiresAt: number;
}

/** スライドをHTML化してS3に保存し、公開URLを返す（OGP対応） */
export async function shareSlide(markdown: string, theme: string = 'border'): Promise<ShareResult> {
  const bucketName = process.env.SHARED_SLIDES_BUCKET;
  const cloudfrontDomain = process.env.CLOUDFRONT_DOMAIN;
  const publicDomain = process.env.SHARED_SLIDES_PUBLIC_DOMAIN || cloudfrontDomain;

  if (!bucketName || !publicDomain) {
    throw new Error('共有機能が設定されていません（環境変数未設定）');
  }

  // スライドソースの形式判定（折衷=HTMLデッキ / それ以外=Marpマークダウン）
  const isDeck = isDeckSource(markdown);

  // スライドID生成（UUID v4）
  const slideId = randomUUID();
  const client = getS3Client();

  // サムネイル生成・アップロード
  let thumbnailUrl: string | null = null;
  try {
    const thumbnailBytes = isDeck ? await generateDeckThumbnail(markdown) : await generateThumbnail(markdown, theme);
    const thumbnailKey = `${slideId}/thumbnail.png`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: thumbnailKey,
        Body: thumbnailBytes,
        ContentType: 'image/png',
      })
    );
    thumbnailUrl = `https://${publicDomain}/${thumbnailKey}`;
    console.log(`[INFO] Thumbnail uploaded: ${thumbnailUrl}`);
  } catch (e) {
    // サムネイル生成に失敗してもHTML共有は続行
    console.warn(`[WARN] Thumbnail generation failed: ${e}`);
  }

  // 共有URL（OGPタグ挿入前に決定）
  const shareUrl = `https://${publicDomain}/${slideId}/index.html`;

  // HTML生成
  let htmlContent = isDeck ? generateDeckStandaloneHtml(markdown) : await generateStandaloneHtml(markdown, theme);

  // OGPタグ挿入（サムネイルがある場合のみ）
  if (thumbnailUrl) {
    const title = (isDeck ? extractDeckTitle(markdown) : extractSlideTitle(markdown)) || 'スライド';
    htmlContent = injectOgpTags(htmlContent, title, thumbnailUrl, shareUrl);
  }

  // S3にHTMLアップロード
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: `${slideId}/index.html`,
      Body: Buffer.from(htmlContent, 'utf-8'),
      ContentType: 'text/html; charset=utf-8',
    })
  );

  // 有効期限（7日後）
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  console.log(`[INFO] Slide shared: ${shareUrl} (expires: ${expiresAt})`);

  return { slideId, url: shareUrl, expiresAt };
}
