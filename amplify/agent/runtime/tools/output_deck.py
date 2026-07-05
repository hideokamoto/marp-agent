"""折衷デッキ出力ツール（HTMLスライドの検証付き）"""

import re
from collections import Counter

from strands import tool

from .output_slide import set_generated_output

_overflow_retry_count: int = 0

MAX_DECK_RETRIES = 2

# セキュリティ上受け入れないパターン（リトライ上限後も拒否する）
_FORBIDDEN_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r'<\s*script\b', re.IGNORECASE), "scriptタグ"),
    (re.compile(r'<\s*iframe\b', re.IGNORECASE), "iframeタグ"),
    (re.compile(r'<\s*object\b', re.IGNORECASE), "objectタグ"),
    (re.compile(r'<\s*embed\b', re.IGNORECASE), "embedタグ"),
    (re.compile(r'\son[a-z]+\s*=', re.IGNORECASE), "イベントハンドラ属性（onclick等）"),
    (re.compile(r'javascript\s*:', re.IGNORECASE), "javascript: URL"),
]

_SLIDE_DIV_RE = re.compile(r'<div\s+class="deck-slide"')
_SECTION_RE = re.compile(r'<section\b')
_MARKER_ID_RE = re.compile(r'<marker\s+id="([^"]+)"')


def _check_security(html: str) -> list[str]:
    """埋め込み不可のパターンを検出"""
    return [label for pattern, label in _FORBIDDEN_PATTERNS if pattern.search(html)]


def _check_structure(html: str) -> list[str]:
    """デッキ構造の問題を検出（リトライ上限後は警告扱いで受理）"""
    problems = []

    div_count = len(_SLIDE_DIV_RE.findall(html))
    section_count = len(_SECTION_RE.findall(html))

    if div_count == 0:
        problems.append(
            'スライドがありません。各スライドは <div class="deck-slide"><section …>…</section></div> の形で出力してください'
        )
    elif section_count != div_count:
        problems.append(
            f'<div class="deck-slide">（{div_count}個）と<section>（{section_count}個）の数が一致しません。1スライド = 1つのdeck-slide div + 1つのsection です'
        )

    # data-label / data-speaker-notes はHUD表示とPPTXノートに必須
    sections_missing_label = section_count - len(re.findall(r'<section[^>]*\bdata-label="', html))
    if section_count and sections_missing_label > 0:
        problems.append(f'data-label属性のないsectionが{sections_missing_label}個あります')
    sections_missing_notes = section_count - len(re.findall(r'<section[^>]*\bdata-speaker-notes="', html))
    if section_count and sections_missing_notes > 0:
        problems.append(f'data-speaker-notes属性のないsectionが{sections_missing_notes}個あります')

    # SVG markerのidはドキュメント全体で一意でないと矢印が正しく描画されない
    marker_ids = _MARKER_ID_RE.findall(html)
    duplicated = [mid for mid, count in Counter(marker_ids).items() if count > 1]
    if duplicated:
        problems.append(
            f'SVGマーカーidが重複しています: {", ".join(duplicated)}。'
            '同じ図解テンプレートを複数スライドで使う場合は、2枚目以降のmarker idと'
            '対応するmarker-end="url(#…)"に連番サフィックスを付けてください（例: fwAh → fwAh-2）'
        )

    return problems


def reset_deck_retry_count() -> None:
    """リトライカウンタをリセット"""
    global _overflow_retry_count
    _overflow_retry_count = 0


@tool
def output_deck(slides_html: str) -> str:
    """生成した折衷スタイルのスライドHTMLを出力します。スライドを作成・編集したら必ずこのツールで出力してください（テキストで直接書き出さない）。

    ## 出力フォーマット

    - システムプロンプトのテンプレートカタログから各スライドのブロックをコピーし、テキストと数字だけを差し替えたHTMLを出力する
    - 全スライドを順番に連結した文字列を渡す。各スライドは `<div class="deck-slide"><section …>…</section></div>` の形
    - `<html>` や `<body>` などのページ枠は出力しない（スライドブロックのみ）
    - 編集や修正の際も、デッキ全体（全スライド）を毎回出力する

    ## 必須ルール

    - 各sectionの `data-label`（短いスライド名）と `data-speaker-notes`（実際の発表原稿。定型説明のコピーではなく内容に即したもの）を必ず設定する
    - インラインstyle・色・クラス（.mincho/.mono）・要素構造はテンプレート通りに保つ。フォントサイズ縮小や新しい色の追加はしない
    - 文字量がテンプレートより多い場合は、文字を小さくするのではなく内容を短くするかスライドを分割する
    - 同じ図解テンプレート（14/15/16）を複数枚使う場合、SVGの `<marker id="…">` と `marker-end="url(#…)"` に連番サフィックスを付けて一意にする
    - script/iframe/イベントハンドラ属性などの動的要素は使用禁止（このツールが自動検証）

    ## 出力後のふるまい

    - 出力完了後は一切喋らない。内容の説明・要約・確認メッセージは全て不要
    - 検証エラーで修正する時は「スライドの構造に問題があったため修正します」のように、何が起きて何をするか短く伝える

    Args:
        slides_html: 全スライドのHTML（deck-slideブロックを順に連結したもの）

    Returns:
        出力完了メッセージ（検証エラー時はエラーメッセージ）
    """
    global _overflow_retry_count

    security_problems = _check_security(slides_html)
    if security_problems:
        return (
            f"使用できない要素が含まれています: {', '.join(security_problems)}\n"
            "該当箇所を削除してから再度 output_deck を呼んでください。"
        )

    structure_problems = _check_structure(slides_html)

    if structure_problems and _overflow_retry_count < MAX_DECK_RETRIES:
        _overflow_retry_count += 1
        details = "\n".join(f"  - {p}" for p in structure_problems)
        return (
            f"デッキ構造に問題があります：\n{details}\n"
            "修正してから再度 output_deck を呼んでください。"
        )

    if structure_problems:
        print(f"[WARN] Deck structure: max retries exceeded, accepting with problems: {structure_problems}")

    set_generated_output(slides_html)
    _overflow_retry_count = 0
    return "スライドを出力しました。"
