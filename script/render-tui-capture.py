#!/usr/bin/env python3
"""Render a sanitized OpenTUI span capture into a PNG.

The capture is produced by the synthetic TUI test harness, never by a screen,
a private project or a hand-made mockup:

  cd packages/tui
  TUI_CAPTURE_DIR=/tmp/captures bun test test/cli/tui/dialog-agent-effort.test.tsx \\
    -t "captures the normal and narrow layout frames"

This helper only turns that span dump into pixels, so a review can compare the
approved layout with what the component actually paints.

Requires Pillow and a DejaVu Sans Mono font (the dev container ships both):

  python3 script/render-tui-capture.py /tmp/captures/agent-effort-normal.json \\
    .github/assets/tui-agent-effort-normal.png "caption"

Usage: render-tui-capture.py <capture.json> <out.png> [caption]
"""

import json
import sys
from collections import Counter

from PIL import Image, ImageDraw, ImageFont

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
FONT_SIZE = 16
MARGIN = 18
CAPTION_GAP = 10
CAPTION_SIZE = 12
FALLBACK_BG = "#0a0a0a"
CAPTION_FG = "#8a8a8a"
CAPTION_FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    source, target = sys.argv[1], sys.argv[2]
    caption = sys.argv[3] if len(sys.argv) > 3 else ""

    capture = json.loads(open(source).read())
    rows = capture["lines"]

    # Trim the frame to the lines and columns the dialog actually paints, so the
    # image is the dialog rather than the empty terminal around it.
    painted = [
        index
        for index, line in enumerate(rows)
        if any(span["text"].strip() for span in line)
    ]
    if not painted:
        raise SystemExit("capture has no painted rows")
    first, last = painted[0], painted[-1]
    rows = rows[first : last + 1]

    # Crop to the dialog panel: the most painted background is the panel, and
    # everything outside it is the dimmed terminal backdrop.
    panel = Counter(span["bg"] for line in rows for span in line if span["bg"]).most_common(1)[0][0]

    def panel_extent(line):
        column = 0
        start = None
        end = None
        for span in line:
            if span["bg"] == panel:
                if start is None:
                    start = column
                end = column + len(span["text"])
            column += len(span["text"])
        return start, end

    extents = [e for e in (panel_extent(line) for line in rows) if e[0] is not None]
    left = min(start for start, _ in extents)
    right = max(end for _, end in extents)

    font = ImageFont.truetype(FONT, FONT_SIZE)
    bold = ImageFont.truetype(FONT_BOLD, FONT_SIZE)
    caption_font = ImageFont.truetype(CAPTION_FONT, CAPTION_SIZE)
    cell_width = round(font.getlength("M"))
    cell_height = FONT_SIZE + 6

    visible = [line for line in rows]
    columns = right - left
    width = max(columns * cell_width, round(caption_font.getlength(caption))) + MARGIN * 2
    height = len(visible) * cell_height + MARGIN * 2 + (CAPTION_SIZE + CAPTION_GAP if caption else 0)

    background = Counter(
        span["bg"] for line in rows for span in line if span["bg"]
    ).most_common(1)
    image = Image.new("RGB", (width, height), background[0][0] if background else FALLBACK_BG)
    draw = ImageDraw.Draw(image)

    for row, line in enumerate(visible):
        column = 0
        y = MARGIN + row * cell_height
        for span in line:
            text = span["text"]
            span_width = len(text)
            x = MARGIN + (column - left) * cell_width
            span_end = column + span_width
            if span_end <= left or column >= right:
                column = span_end
                continue
            if span["bg"]:
                draw.rectangle(
                    [x, y, x + span_width * cell_width, y + cell_height - 1],
                    fill=span["bg"],
                )
            draw.text(
                (x, y),
                text,
                font=bold if span["bold"] else font,
                fill=span["fg"],
            )
            column = span_end

    if caption:
        draw.text(
            (MARGIN, height - MARGIN - CAPTION_SIZE),
            caption,
            font=caption_font,
            fill=CAPTION_FG,
        )

    image.save(target, "PNG")
    print(f"{target}: {width}x{height} from {source}")


if __name__ == "__main__":
    main()
