# Playwright E2E (extension loaded)

**You do not need Playwright to use the extension** — it is only an automated check for developers. Ignore this folder if you just want YouTube to work.

The browser starts with this repo as an **unpacked Chromium extension** (`manifest.json` in the parent folder).

## One-time setup

```bash
cd /path/to/remove-multi-titles-yt
npm install
```

`npm install` runs **`playwright install chromium`** automatically (`postinstall`). If you still see **“Executable doesn’t exist”**, run:

```bash
npx playwright install chromium
```

## Run

```bash
npm run test:e2e
```

This script uses a **real display** when `DISPLAY` is set (normal desktop terminal). If `DISPLAY` is empty (SSH, some IDE terminals), it automatically uses **`xvfb-run`** when Xvfb is installed.

**Install Xvfb** (Arch / CachyOS): `sudo pacman -S xorg-server-xvfb`

**Force headed** (only when you have a GUI): `npm run test:e2e:headed`

**Force xvfb** from any environment: `npm run test:e2e:ci`

Or use the **Playwright Test for VS Code** extension: open the Testing sidebar, enable **Show browsers**, run `title-persistence`.

Headed mode is required — MV3 extensions are not loaded in headless Chromium.

## First run / EU

If YouTube shows a cookie or sign-in wall, complete it once in the window Playwright opens. The test uses two public watch URLs and does not need login.

## What the test checks

Opens video A, reads `#primary h1.ytd-watch-metadata`, then opens video B, reads the same selector. It fails if both titles are identical (regression for “stuck on first video’s title”). Console output includes `ytd-player` `video-id` and all `#primary ytd-watch-metadata` blocks for debugging.
