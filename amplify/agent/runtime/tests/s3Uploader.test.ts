/** shareSlide のユニットテスト — Python版 test_share_slide.py の移植 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// marp CLI / Chromium を呼ぶエクスポート層をモック
vi.mock('../src/exports/slideExporter.js', () => ({
  generateStandaloneHtml: vi.fn(async () => '<html><head></head><body>ok</body></html>'),
  generateThumbnail: vi.fn(async () => Buffer.from('png')),
}));
vi.mock('../src/exports/deckExporter.js', () => ({
  isDeckSource: (source: string) => source.trimStart().startsWith('<'),
  extractDeckTitle: vi.fn(() => 'デッキタイトル'),
  generateDeckStandaloneHtml: vi.fn(() => '<html><head></head><body>deck</body></html>'),
  generateDeckThumbnail: vi.fn(async () => Buffer.from('deckpng')),
}));

import { shareSlide, injectOgpTags, extractSlideTitle, setS3ClientForTesting } from '../src/sharing/s3Uploader.js';
import type { S3Client } from '@aws-sdk/client-s3';

interface CapturedPut {
  Bucket?: string;
  Key?: string;
  Body?: Buffer;
  ContentType?: string;
}

function fakeS3(): { client: S3Client; puts: CapturedPut[] } {
  const puts: CapturedPut[] = [];
  const client = {
    send: vi.fn(async (command: { input: CapturedPut }) => {
      puts.push(command.input);
      return {};
    }),
  } as unknown as S3Client;
  return { client, puts };
}

beforeEach(() => {
  process.env.SHARED_SLIDES_BUCKET = 'shared-bucket';
  process.env.CLOUDFRONT_DOMAIN = 'd111111abcdef8.cloudfront.net';
  process.env.SHARED_SLIDES_PUBLIC_DOMAIN = 'slides.pawapo.minoruonda.com';
});

afterEach(() => {
  setS3ClientForTesting(null);
  delete process.env.SHARED_SLIDES_BUCKET;
  delete process.env.CLOUDFRONT_DOMAIN;
  delete process.env.SHARED_SLIDES_PUBLIC_DOMAIN;
});

describe('shareSlide', () => {
  it('独自ドメインがある場合は共有URLとOGP画像にそれを使う', async () => {
    const { client, puts } = fakeS3();
    setS3ClientForTesting(client);

    const result = await shareSlide('# テスト');

    expect(result.url).toMatch(
      /^https:\/\/slides\.pawapo\.minoruonda\.com\/[0-9a-f-]{36}\/index\.html$/
    );
    expect(puts).toHaveLength(2);
    expect(puts[0].Key).toMatch(/thumbnail\.png$/);
    expect(puts[1].Body!.toString()).toContain('slides.pawapo.minoruonda.com');
    expect(puts[1].Body!.toString()).toContain('thumbnail.png');
  });

  it('独自ドメイン未設定時はCloudFrontドメインを使う', async () => {
    delete process.env.SHARED_SLIDES_PUBLIC_DOMAIN;
    const { client } = fakeS3();
    setS3ClientForTesting(client);

    const result = await shareSlide('# テスト');
    expect(result.url).toContain('d111111abcdef8.cloudfront.net');
  });

  it('環境変数未設定なら例外', async () => {
    delete process.env.SHARED_SLIDES_BUCKET;
    await expect(shareSlide('# テスト')).rejects.toThrow('共有機能が設定されていません');
  });

  it('折衷デッキはデッキ用のHTML・サムネイル生成を使う', async () => {
    const { client, puts } = fakeS3();
    setS3ClientForTesting(client);

    const result = await shareSlide('<div class="deck-slide"><section></section></div>');

    expect(result.url).toContain('slides.pawapo.minoruonda.com');
    expect(puts[0].Body!.toString()).toBe('deckpng');
    expect(puts[1].Body!.toString()).toContain('deck');
    // OGPタイトルにデッキタイトルが使われる
    expect(puts[1].Body!.toString()).toContain('デッキタイトル');
  });
});

describe('extractSlideTitle', () => {
  it('最初の見出しをタイトルとして抽出', () => {
    expect(extractSlideTitle('---\nmarp: true\n---\n# タイトル\n\n本文')).toBe('タイトル');
  });

  it('見出しがなければnull', () => {
    expect(extractSlideTitle('本文だけ')).toBeNull();
  });
});

describe('injectOgpTags', () => {
  it('OGPタグを</head>の前に挿入し、タイトルをエスケープする', () => {
    const html = '<html><head><meta property="og:title" content="old"></head><body></body></html>';
    const result = injectOgpTags(html, 'タイトル<script>', 'https://img.example/t.png', 'https://page.example/');

    expect(result).not.toContain('content="old"');
    expect(result).toContain('タイトル&lt;script&gt;');
    expect(result).toContain('https://img.example/t.png');
    expect(result).toContain('summary_large_image');
  });
});
