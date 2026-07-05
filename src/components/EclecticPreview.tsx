import { useEffect, useMemo, useRef, useState } from 'react';
import { extractDeckSlides } from '../utils/deckFormat';

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;

/** 1920×1080設計のスライドをコンテナ幅に合わせて縮小表示する */
function ScaledSlide({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = () => setScale(el.clientWidth / DESIGN_WIDTH);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      style={{ aspectRatio: '16 / 9' }}
    >
      <div
        className="eclectic-slide-canvas absolute top-0 left-0"
        style={{
          width: DESIGN_WIDTH,
          height: DESIGN_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          visibility: scale > 0 ? 'visible' : 'hidden',
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** 折衷デッキ（HTMLスライド）のプレビュー一覧 */
export function EclecticPreview({ source }: { source: string }) {
  const slides = useMemo(() => extractDeckSlides(source), [source]);

  if (slides.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        <p className="text-lg">スライドを読み込めませんでした</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {slides.map((html, index) => (
        <div
          key={index}
          className="border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow bg-white"
        >
          <ScaledSlide html={html} />
          <div className="bg-gray-100 px-3 py-1 text-xs text-gray-600 border-t text-center">
            スライド {index + 1}/{slides.length}
          </div>
        </div>
      ))}
    </div>
  );
}
