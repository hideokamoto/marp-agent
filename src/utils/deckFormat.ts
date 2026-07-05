/**
 * スライドソースの形式判定ユーティリティ
 * 折衷デッキ（HTML）と Marpマークダウンの2形式が同じ状態変数を流れる
 */

/** 折衷デッキ（deck-slideブロックのHTML）かどうかを判定 */
export function isDeckHtml(source: string): boolean {
  if (!source) return false;
  // 先頭のHTMLコメントをスキップして判定
  const stripped = source.replace(/^\s*(<!--[\s\S]*?-->\s*)*/, '');
  return stripped.startsWith('<');
}

/** デッキHTMLから各スライドのsection HTMLを抽出 */
export function extractDeckSlides(source: string): string[] {
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const slides = Array.from(doc.querySelectorAll('.deck-slide section'));
  if (slides.length > 0) {
    return slides.map(section => section.outerHTML);
  }
  // deck-slideラッパーなしでsectionだけ出力された場合のフォールバック
  return Array.from(doc.querySelectorAll('section')).map(section => section.outerHTML);
}
