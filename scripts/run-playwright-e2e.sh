#!/usr/bin/env sh
# Headed Chromium is required for MV3 extensions. Use a real display when available;
# otherwise fall back to Xvfb (install: sudo pacman -S xorg-server-xvfb on CachyOS/Arch).
set -e
cd "$(dirname "$0")/.."

if [ -n "${DISPLAY:-}" ]; then
  exec npx playwright test "$@"
fi

if command -v xvfb-run >/dev/null 2>&1; then
  exec xvfb-run -a npx playwright test "$@"
fi

echo "Playwright needs a display for extension tests (headed browser)." >&2
echo "Either:" >&2
echo "  • Run this from a desktop terminal (so DISPLAY is set), or" >&2
echo "  • Install Xvfb and retry: sudo pacman -S xorg-server-xvfb   # Arch/CachyOS" >&2
echo "  • Then: npm run test:e2e:ci   (same as xvfb-run -a playwright test)" >&2
exit 1
