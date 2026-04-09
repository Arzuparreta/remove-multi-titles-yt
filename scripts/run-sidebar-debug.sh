#!/usr/bin/env sh
# Run sidebar thumbnail A/B test; use Xvfb when no DISPLAY (e.g. SSH/CI).
set -e
cd "$(dirname "$0")/.."
npm run build:chrome-unpacked
if [ -n "${DISPLAY}" ]; then
  exec npx playwright test sidebar-thumb-nav-debug.spec.js "$@"
else
  exec xvfb-run -a npx playwright test sidebar-thumb-nav-debug.spec.js "$@"
fi
