#!/usr/bin/env python3
"""Build extension PNG icons from a square source: white → transparent, trim, scale."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

# Chrome Web Store / MV3 common; Firefox AMO accepts the same set plus larger optional.
SIZES = (16, 32, 48, 64, 96, 128, 256, 512)


def white_to_transparent(im: Image.Image, threshold: int = 248) -> Image.Image:
    im = im.convert("RGBA")
    pixels = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            if r >= threshold and g >= threshold and b >= threshold:
                pixels[x, y] = (0, 0, 0, 0)
            else:
                pixels[x, y] = (r, g, b, a)
    return im


def trim_and_pad_icon(src: Image.Image, size: int, margin_ratio: float = 0.1) -> Image.Image:
    bbox = src.getbbox()
    if not bbox:
        return Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cropped = src.crop(bbox)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    w, h = cropped.size
    margin = int(size * margin_ratio)
    max_inner = max(1, size - 2 * margin)
    scale = min(max_inner / w, max_inner / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    thumb = cropped.resize((nw, nh), Image.Resampling.LANCZOS)
    ox = (size - nw) // 2
    oy = (size - nh) // 2
    out.paste(thumb, (ox, oy), thumb)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("source", type=Path, help="Source image (PNG/JPEG)")
    p.add_argument(
        "-o",
        "--out-dir",
        type=Path,
        default=Path("icons"),
        help="Output directory for iconNNN.png",
    )
    args = p.parse_args()
    if not args.source.is_file():
        print(f"Missing source: {args.source}", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    base = Image.open(args.source)
    rgba = white_to_transparent(base)

    for sz in SIZES:
        icon = trim_and_pad_icon(rgba, sz)
        out_path = args.out_dir / f"icon{sz}.png"
        icon.save(out_path, "PNG", optimize=True)
        print("Wrote", out_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
