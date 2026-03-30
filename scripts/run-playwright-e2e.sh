#!/usr/bin/env sh
# Run E2E with a virtual display when no DISPLAY (e.g. SSH/CI).
set -e
cd "$(dirname "$0")/.."
node scripts/sync-chrome-unpacked.mjs
if [ -n "${DISPLAY}" ]; then
  exec npx playwright test "$@"
else
  exec xvfb-run -a npx playwright test "$@"
fi
