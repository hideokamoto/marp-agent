"""output_deck ツールと deck_exporter のユニットテスト"""
from tools.output_slide import get_generated_markdown, reset_generated_markdown
from tools.output_deck import output_deck, reset_deck_retry_count, MAX_DECK_RETRIES
from exports.deck_exporter import (
    is_deck_source,
    extract_deck_title,
    assemble_deck_html,
)


def _valid_deck(marker_suffix: str = "") -> str:
    return f'''<div class="deck-slide">
  <section data-label="タイトル" data-speaker-notes="表紙の説明" style="background:#F5F2EC;">
    <h1 class="mincho">テスト<br>スライド</h1>
    <svg><defs><marker id="ah{marker_suffix}"></marker></defs></svg>
  </section>
</div>'''


def _reset():
    reset_generated_markdown()
    reset_deck_retry_count()


# --- output_deck: 検証と保存 ---

def test_output_deck_stores_valid_html():
    """正常なデッキHTMLは保存される"""
    _reset()
    deck = _valid_deck()

    result = output_deck(slides_html=deck)

    assert result == "スライドを出力しました。"
    assert get_generated_markdown() == deck


def test_output_deck_rejects_script_tag():
    """scriptタグは拒否される（リトライ後も受理しない）"""
    _reset()
    deck = _valid_deck() + '<script>alert(1)</script>'

    for _ in range(MAX_DECK_RETRIES + 2):
        result = output_deck(slides_html=deck)
        assert "使用できない要素" in result

    assert get_generated_markdown() is None


def test_output_deck_rejects_event_handler():
    """イベントハンドラ属性は拒否される"""
    _reset()
    deck = _valid_deck().replace('<section ', '<section onclick="x()" ')

    result = output_deck(slides_html=deck)

    assert "使用できない要素" in result
    assert get_generated_markdown() is None


def test_output_deck_requires_deck_slide_wrapper():
    """deck-slideラッパーがないと構造エラー"""
    _reset()

    result = output_deck(slides_html='<section data-label="a" data-speaker-notes="b"></section>')

    assert "デッキ構造に問題" in result
    assert get_generated_markdown() is None


def test_output_deck_detects_missing_labels():
    """data-label / data-speaker-notes の欠落を検出"""
    _reset()
    deck = '<div class="deck-slide"><section style="background:#F5F2EC;"></section></div>'

    result = output_deck(slides_html=deck)

    assert "data-label" in result
    assert "data-speaker-notes" in result


def test_output_deck_detects_duplicate_marker_ids():
    """SVGマーカーidの重複を検出"""
    _reset()
    deck = _valid_deck() + _valid_deck()

    result = output_deck(slides_html=deck)

    assert "マーカーid" in result
    assert get_generated_markdown() is None


def test_output_deck_accepts_unique_marker_ids():
    """サフィックスで一意になったマーカーidは受理"""
    _reset()
    deck = _valid_deck() + _valid_deck(marker_suffix="-2")

    result = output_deck(slides_html=deck)

    assert result == "スライドを出力しました。"


def test_output_deck_accepts_after_max_retries():
    """構造の問題はリトライ上限後に警告付きで受理される"""
    _reset()
    deck = '<div class="deck-slide"><section style="background:#F5F2EC;"></section></div>'

    for _ in range(MAX_DECK_RETRIES):
        result = output_deck(slides_html=deck)
        assert "デッキ構造に問題" in result

    result = output_deck(slides_html=deck)
    assert result == "スライドを出力しました。"
    assert get_generated_markdown() == deck


# --- deck_exporter: 形式判定・タイトル抽出・HTML組み立て ---

def test_is_deck_source_detects_html():
    assert is_deck_source(_valid_deck()) is True
    assert is_deck_source('  \n<!-- コメント -->\n<div class="deck-slide">') is True


def test_is_deck_source_rejects_marp_markdown():
    assert is_deck_source("---\nmarp: true\n---\n# タイトル") is False
    assert is_deck_source("# タイトル\n\n- 箇条書き") is False


def test_extract_deck_title_strips_tags():
    title = extract_deck_title(_valid_deck())
    assert title == "テスト スライド"


def test_extract_deck_title_falls_back_to_none():
    assert extract_deck_title('<div class="deck-slide"><section></section></div>') is None


def test_assemble_deck_html_injects_slides_and_title():
    deck = _valid_deck()

    html = assemble_deck_html(deck)

    assert "<!DOCTYPE html>" in html
    assert deck in html
    assert "<title>テスト スライド</title>" in html
    # CSS/JSがインライン化され、外部参照が残っていない
    assert 'href="deck.css"' not in html
    assert 'src="deck.js"' not in html
    assert "#stage-scaler" in html  # deck.cssの内容
    assert "deckdeck" in html  # deck.jsの内容


def test_assemble_deck_html_escapes_title():
    html = assemble_deck_html('<div class="deck-slide"><section></section></div>', title='<b>悪意&タイトル</b>')

    assert "<title>&lt;b&gt;悪意&amp;タイトル&lt;/b&gt;</title>" in html
