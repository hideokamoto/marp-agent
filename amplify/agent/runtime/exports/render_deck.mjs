/* ==========================================================================
   render_deck.mjs — 折衷デッキの各スライドを1920×1080のPNGにレンダリング
   （deckdeckのrender_slides.mjsをAgentCoreランタイム向けに調整したもの）

   Usage:
     node render_deck.mjs <deck.html> <out-dir> [--scale N] [--limit N]

   Output:
     <out-dir>/slide-01.png … slide-NN.png   (1920×1080 × scale)
     <out-dir>/notes.json                     [{index,label,notes}]
   ========================================================================== */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* ---- playwright-core をグローバルインストール先から解決 ----------------- */
async function loadPlaywright() {
  const candidates = [
    'playwright-core',
    'playwright',
    '/usr/local/lib/node_modules/playwright-core/index.mjs',
    '/usr/lib/node_modules/playwright-core/index.mjs',
    '/usr/local/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
    '/opt/node22/lib/node_modules/playwright/index.mjs'
  ];
  for (const c of candidates) {
    try { return await import(c); } catch { /* try next */ }
  }
  throw new Error('playwright-core not found. Install with: npm i -g playwright-core');
}

function findChromium() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

async function main() {
  const [, , deckArg, outArg, ...rest] = process.argv;
  if (!deckArg || !outArg) {
    console.error('Usage: node render_deck.mjs <deck.html> <out-dir> [--scale N] [--limit N]');
    process.exit(2);
  }
  const deckPath = resolve(deckArg);
  const outDir = resolve(outArg);
  const scaleIdx = rest.indexOf('--scale');
  const scale = scaleIdx >= 0 ? Number(rest[scaleIdx + 1]) : 2;
  const limitIdx = rest.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1]) : Infinity;
  mkdirSync(outDir, { recursive: true });

  const { chromium } = await loadPlaywright();
  const exe = findChromium();
  if (!exe) throw new Error('Chromium not found (set PUPPETEER_EXECUTABLE_PATH).');
  // AgentCoreコンテナはroot実行のためsandboxを無効化
  const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });

  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: scale
    });
    await page.goto(pathToFileURL(deckPath).href, { waitUntil: 'networkidle' })
      .catch((e) => console.error(`Warning: navigation issue: ${e.message}`));
    // Webフォント（Shippori Mincho等）の読み込みを待つ。オフライン時はフォールバックで続行
    await page.waitForTimeout(600);
    try { await page.evaluate(() => document.fonts && document.fonts.ready); }
    catch (e) { console.error(`Warning: font wait failed: ${e.message}`); }

    // キャプチャ用にフラット化: フィットスケールを無効化し、プレゼン用UIを隠し、
    // スライドを1枚ずつ表示する
    await page.addStyleTag({ content: `
      #stage-scaler{position:absolute!important;left:0!important;top:0!important;
        transform:none!important;width:1920px!important;height:1080px!important;}
      .deck-slide{position:absolute!important;inset:0!important;display:none!important;}
      .deck-slide.__cap{display:block!important;}
      .progress,.hud,.notes,.overview,.help{display:none!important;}
      html,body{background:#F5F2EC!important;overflow:hidden!important;}
    `});

    const slides = await page.$$('.deck-slide');
    const total = Math.min(slides.length, limit);
    if (slides.length === 0) {
      throw new Error(`No .deck-slide elements found in ${deckPath} — the deck failed to load.`);
    }
    const notes = [];
    console.log(`Rendering ${total} slide(s) at ${1920 * scale}×${1080 * scale}…`);

    for (let i = 0; i < total; i++) {
      const info = await page.evaluate((idx) => {
        const all = document.querySelectorAll('.deck-slide');
        all.forEach((el, k) => el.classList.toggle('__cap', k === idx));
        const sec = all[idx].querySelector('section');
        return {
          label: (sec && sec.dataset.label) || '',
          notes: (sec && sec.dataset.speakerNotes) || ''
        };
      }, i);
      await page.waitForTimeout(120);
      const file = join(outDir, `slide-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
      notes.push({ index: i + 1, label: info.label, notes: info.notes });
      console.log(`  slide-${String(i + 1).padStart(2, '0')}.png  ${info.label}`);
    }

    writeFileSync(join(outDir, 'notes.json'), JSON.stringify(notes, null, 2));
    console.log(`Done -> ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
