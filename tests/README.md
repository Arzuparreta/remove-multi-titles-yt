# Playwright E2E

Chromium starts with this repo as an **unpacked extension**. Headed browser is required (extensions do not load in headless).

## What we test (and what we cannot)

YouTube **does not** flip A/B titles on every refresh, and **many videos have a single title**. So we **do not** assert “YouTube showed two variants” — we assert **pin invariants** that must hold if multi-title repetition is prevented:

1. **Round-trip** — First title seen for video A is shown again after leaving and returning to A (full `goto`), matching `chrome.storage` behaviour.
2. **Same-page stability** — Watch `h1` text is unchanged across several seconds on one load (guards against mid-session flips; extension should keep one string).
3. **SPA navigation** — After in-page navigation to B, B’s title differs from A’s (sanity).

First YouTube visit may show a consent screen; complete it once in the opened browser.

## Commands

```bash
npm install
npm run test:e2e
```

No `DISPLAY`: install Xvfb (e.g. `sudo pacman -S xorg-server-xvfb`) or use `npm run test:e2e:ci`.

## Sidebar thumbnail A/B (extension vs none)

`npm run test:debug:sidebar` runs the same navigation test twice: **with-extension** and **no-extension**. It picks a **visible** sidebar watch link (skips title links and hidden promos such as `yt-video-attribute-view-model`), scrolls it into view, clicks, and expects `?v=` to change. The current page’s `v` is used to exclude the active video (YouTube may redirect away from the entry URL).

In CI/Xvfb, both projects have been observed to pass, so a human-only bug may need **headed** runs, **prefilled `chrome.storage` pins**, or a different rec row. If **no-extension** passes and **with-extension** fails on your machine, the regression is extension-specific.
