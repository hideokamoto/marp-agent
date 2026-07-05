# 折衷デッキ（Claude Designスタイル）

「折衷 技術スライド集」（Claude Designで作成したデッキ）の見た目でスライドを生成するモード。
Marpマークダウンではなく、17種のテンプレートに基づく**HTMLスライド**を生成する。
元となるデザインシステムは [deckdeck リポジトリ](https://github.com/hideokamoto/deckdeck) で管理している。

## 仕組み

```
テーマ選択 eclectic
  → エージェント: output_deck ツールで deck-slide ブロックのHTMLを出力
  → フロント: EclecticPreview が 1920×1080 のスライドを縮小表示
  → エクスポート: HTML組み立て → Chromiumで各スライドをPNG化 → PPTX（全面画像＋ノート）/ PDF
  → 共有: 自己完結型HTML（deck.css/deck.js インライン）をS3へ
```

## スライドソースの2形式

フロントの `markdown` state / SSEの `markdown` イベント / エクスポートAPIの `markdown` フィールドには、
テーマに応じて2形式のソースが流れる：

| 形式 | 判定 | 生成ツール | エクスポート |
|------|------|-----------|-------------|
| Marpマークダウン | 先頭が `<` 以外 | `output_slide` | Marp CLI |
| 折衷HTMLデッキ | 先頭が `<`（`is_deck_source` / `isDeckHtml`） | `output_deck` | `deck_exporter` |

形式判定はテーマ値ではなく**内容ベース**（生成後にテーマを切り替えても壊れないように）。

## 主要ファイル

| パス | 内容 |
|------|------|
| `amplify/agent/runtime/decks/eclectic/` | deckdeck由来のアセット（deck-shell.html, deck.css, deck.js, slide-blocks.html） |
| `amplify/agent/runtime/tools/output_deck.py` | デッキ出力ツール（構造・セキュリティ検証付き） |
| `amplify/agent/runtime/config.py` | `_get_eclectic_system_prompt()`（デザインシステム＋テンプレートカタログ＋全ブロックを含む） |
| `amplify/agent/runtime/exports/deck_exporter.py` | HTML組み立て・PNG/PPTX/PDF/サムネイル生成 |
| `amplify/agent/runtime/exports/render_deck.mjs` | playwright-core + 同梱Chromiumで各スライドをPNG化 |
| `src/components/EclecticPreview.tsx` | プレビュー（ResizeObserverで1920×1080をスケーリング） |
| `src/utils/deckFormat.ts` | 形式判定・section抽出 |

## 検証ルール（output_deck）

- script/iframe/object/embed/イベントハンドラ属性/javascript: URL → **常に拒否**
- deck-slide と section の個数一致、data-label / data-speaker-notes の存在、
  SVGマーカーidの一意性 → 2回までリトライさせ、以降は警告ログ付きで受理

## 制約・注意点

- **編集可能PPTXは未対応**（スライドは全面画像。フロントでもボタン非表示、バックエンドでもエラー返却）
- システムプロンプトに約50KBのテンプレートブロックを含むため、**プロンプトキャッシュ（cache_prompt）が前提**
- Webフォント（Shippori Mincho / Zen Kaku Gothic New）はGoogle Fontsから読み込む。
  ランタイムがオフラインの場合はフォールバックフォントでレンダリングされる
- Dockerイメージには `playwright-core`（ブラウザ同梱なし、aptのChromiumを使用）と
  `python-pptx` / `img2pdf` が必要（Dockerfile / requirements.txt に追加済み）

## deckdeckリポジトリとの同期

デザインを変更する場合は Claude Design で編集 → deckdeck 側で再抽出 → 以下をコピーする：

```bash
cp ../deckdeck/.claude/skills/tech-slides/assets/{deck-shell.html,deck.css,deck.js,slide-blocks.html} \
   amplify/agent/runtime/decks/eclectic/
```

テンプレート構成（17種の一覧・選び方）は `deckdeck/.claude/skills/tech-slides/references/` を参照。
config.py のカタログ表はテンプレート増減時に手動で更新する。
