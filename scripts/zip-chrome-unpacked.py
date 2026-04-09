#!/usr/bin/env python3
"""Zip dist/chrome-unpacked for Chrome Web Store (manifest at archive root)."""
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = root / "dist" / "chrome-unpacked"
out = root / "dist" / "remove-multi-titles-yt-chrome.zip"

if not (src / "manifest.json").exists():
    print(
        "Missing dist/chrome-unpacked/. Run: npm run build:chrome-unpacked",
        file=sys.stderr,
    )
    sys.exit(1)

out.parent.mkdir(parents=True, exist_ok=True)
if out.exists():
    out.unlink()

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for path in src.rglob("*"):
        if path.is_file():
            zf.write(path, path.relative_to(src))

print("Chrome Web Store ZIP →", out)
