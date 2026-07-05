/**
 * モック実装（ローカル開発用）
 */

import type { AgentCoreCallbacks, ModelType } from '../api/agentCoreClient';
import type { ReferenceFile } from '../../components/Chat/types';
import type { ShareResult } from '../api/exportClient';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * エージェント実行モック
 */
// 折衷デッキのモック出力（タイトル＋ステートメント＋まとめの3枚）
function buildMockDeck(prompt: string): string {
  return `<div class="deck-slide">
  <section data-label="タイトル" data-speaker-notes="表紙です。" style="background:#F5F2EC;padding:120px 110px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="width:26px;height:26px;border-radius:7px;background:#2F5375;"></div>
      <span class="mono" style="font-size:24px;letter-spacing:3px;color:#7B7E82;text-transform:uppercase;">Mock Deck</span>
    </div>
    <div>
      <div style="width:80px;height:6px;background:#E0A63C;border-radius:3px;margin-bottom:40px;"></div>
      <h1 class="mincho" style="font-weight:600;font-size:104px;line-height:1.2;margin:0;color:#23262B;">${prompt}</h1>
      <p style="font-size:36px;color:#5C5F63;margin:44px 0 0;line-height:1.6;">モックモードのサンプルスライド</p>
    </div>
    <div style="display:flex;align-items:center;gap:20px;font-size:28px;color:#5C5F63;">
      <span style="color:#23262B;font-weight:500;">パワポ作るマン</span>
    </div>
  </section>
</div>
<div class="deck-slide">
  <section data-label="ステートメント" data-speaker-notes="主張を一文で伝えます。" style="background:#F5F2EC;padding:120px 140px;display:flex;flex-direction:column;justify-content:center;box-sizing:border-box;">
    <span class="mono" style="font-size:26px;letter-spacing:3px;color:#B0A48F;text-transform:uppercase;margin-bottom:48px;">Statement</span>
    <p class="mincho" style="font-size:76px;line-height:1.55;margin:0;color:#23262B;font-weight:500;">これは<span style="color:#2F5375;">折衷デッキ</span>の<span style="color:#E0A63C;">モック</span>です。</p>
  </section>
</div>
<div class="deck-slide">
  <section data-label="まとめ" data-speaker-notes="締めのスライドです。" style="background:#16181C;padding:120px 110px;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;">
    <div>
      <span class="mono" style="font-size:26px;letter-spacing:4px;color:#6E9BC0;text-transform:uppercase;">Wrap up</span>
      <h2 class="mincho" style="font-weight:600;font-size:88px;line-height:1.3;margin:28px 0 56px;color:#E9E7DF;">まとめ</h2>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #2E3138;padding-top:40px;">
      <div class="mincho" style="font-size:44px;color:#E9E7DF;">ご清聴ありがとうございました</div>
    </div>
  </section>
</div>`;
}

export async function invokeAgentMock(
  prompt: string,
  _currentMarkdown: string,
  theme: string,
  callbacks: AgentCoreCallbacks,
  _sessionId?: string,
  _modelType: ModelType = 'sonnet',
  _referenceFile?: ReferenceFile
): Promise<void> {
  void _modelType;
  void _referenceFile;

  // 思考過程をストリーミング
  const thinkingText = `${prompt}についてスライドを作成しますね。\n\n構成を考えています...`;
  for (const char of thinkingText) {
    callbacks.onText(char);
    await sleep(20);
  }

  // 折衷テーマの場合はHTMLデッキのモックを返す
  if (theme === 'eclectic') {
    callbacks.onToolUse('output_deck');
    await sleep(1000);
    callbacks.onMarkdown(buildMockDeck(prompt));
    callbacks.onText('\n\nスライドを生成しました！プレビュータブで確認できます。');
    callbacks.onComplete();
    return;
  }

  // ツール使用開始
  callbacks.onToolUse('output_slide');
  await sleep(1000);

  // サンプルマークダウンを生成
  const sampleMarkdown = `---
marp: true
theme: border
size: 16:9
paginate: true
---

# ${prompt}

サンプルスライド

---

# スライド 2

- ポイント 1
- ポイント 2
- ポイント 3

---

# まとめ

ご清聴ありがとうございました
`;

  callbacks.onMarkdown(sampleMarkdown);
  callbacks.onText('\n\nスライドを生成しました！プレビュータブで確認できます。');

  // シェアリクエストの場合はツイートURLを生成
  if (prompt.includes('シェア') || prompt.includes('ツイート')) {
    callbacks.onToolUse('generate_tweet_url');
    await sleep(500);
    const tweetText = encodeURIComponent(`#パワポ作るマン でスライドを作ってみました。これは便利！ pawapo.minoruonda.com`);
    callbacks.onTweetUrl?.(`https://twitter.com/intent/tweet?text=${tweetText}`);
  }

  callbacks.onComplete();
}

/**
 * PDF生成モック
 */
export async function exportPdfMock(markdown: string, _theme: string = 'border'): Promise<Blob> {
  void _theme;
  await sleep(1000);
  return new Blob([markdown], { type: 'text/markdown' });
}

/**
 * PPTX生成モック
 */
export async function exportPptxMock(markdown: string, _theme: string = 'border'): Promise<Blob> {
  void _theme;
  await sleep(1000);
  return new Blob([markdown], { type: 'text/markdown' });
}

/**
 * 編集可能PPTX生成モック
 */
export async function exportEditablePptxMock(markdown: string, _theme: string = 'border'): Promise<Blob> {
  void _theme;
  await sleep(2000);
  return new Blob([markdown], { type: 'text/markdown' });
}

/**
 * スライド共有モック
 */
export async function shareSlideMock(_markdown: string, _theme: string = 'border'): Promise<ShareResult> {
  void _theme;
  await sleep(1000);
  const mockSlideId = crypto.randomUUID();
  return {
    url: `https://slides.pawapo.minoruonda.com/${mockSlideId}/index.html`,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };
}
