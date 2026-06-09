# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a browser extension that pins the first-seen title and thumbnail per YouTube video to prevent A/B testing title and thumbnail flicker. It runs on youtube.com only and stores titles and thumbnails locally using browser storage. The extension works on watch pages, Shorts, and grid lists (home, subscriptions, search results, related videos).

## Development Commands

### Building
- `npm run build:chrome-unpacked` - Creates Chrome MV3 bundle in `dist/chrome-unpacked/` (converts Firefox manifest to Chrome service_worker format)
- `npm run build:chrome-zip` - Builds Chrome unpacked bundle and creates ZIP for Web Store submission
- `npm run build:amo` - Creates Firefox AMO package in `dist-amo/` using web-ext
- `npm run build:icons` - Regenerates icon PNGs from source JPEG

### Testing
- `npm run test:e2e` - Runs Playwright E2E tests (requires Xvfb or headed browser)
- `npm run test:e2e:headed` - Runs E2E tests with visible browser (after building Chrome unpacked)
- `npm run test:e2e:ci` - Runs E2E tests with Xvfb for CI environments
- `npm run test:e2e:ui` - Opens Playwright UI for test development
- `npm run test:debug:sidebar` - Debugs sidebar thumbnail navigation with and without extension

### Linting
- `npm run lint:ext` - Lints extension using web-ext

## Architecture

### Core Design Philosophy
The extension avoids fighting YouTube's UI by not attaching continuous MutationObservers to the watch title. Instead, it reacts to YouTube's own page events (`yt-page-data-updated`, `yt-navigate-finish`) with a small bounded-retry safety net for the watch player, and uses debounced subtree observers for grid lists. A single reconciliation engine (`reconcileTarget`) decides "apply the pin" vs "learn the native value" for every surface, so titles and thumbnails are handled homogeneously.

### Key Components

**content.js** - Main extension logic:
- **Storage layer**: One unified record per video, `ytPin:<id> = { t, th, ts }` (title, thumbnail URL, last-write epoch), accessed via `getPins`/`commitPins` (one round-trip each). `mergeRecord` keeps the untouched field on partial writes.
- **Reconciliation engine**: `reconcileTarget({ videoId, titleEl, thumbEl }, record, opts)` is the only place that pins or learns. Watch passes `thumbEl: null` (the player occupies that space) and an `expectTitle` guard; grid passes both.
- **Watch/Shorts handling (`applyPlayer`)**: Runs on page events with a generation guard (`playerApplyGen`) + URL re-check so a stale apply never writes after navigation. Learns a title only when the DOM matches `document.title` (settled), except on the final `PLAYER_RETRY_MS` attempt.
- **Grid/List handling (`applyGridLocks`)**: Debounced subtree observers on `#contents`, miniplayer, Shorts, and `#primary-inner` (excludes `#secondary`). Captures the id per card at scan time and **re-verifies** `cardVideoId(card)` right before writing (YouTube recycles card DOM during scroll). A `WeakMap` skip cache drops already-reconciled, unchanged cards before the storage read.
- **Video ID extraction**: Prefers YouTube's `yt-navigate-finish` event detail, falls back to URL parsing (`?v=` or Shorts path).
- **Title text updates**: Mutates text nodes in place (including open shadow subtrees) rather than assigning `textContent`.
- **LRU pruning**: After ~`PRUNE_CHECK_EVERY` newly learned records, `selectKeysToEvict` trims storage back to `PIN_MAX` by oldest `ts`.
- **Migration**: One-time fold of legacy `ytTitleLock:` / `ytThumbLock:` keys into `ytPin:` records, gated by `ytPinSchema`; apply passes `await migrationReady`.

**background.js** - Minimal background script (Firefox) or service worker (Chrome) for extension lifecycle

### Important Constants
- `PIN_PREFIX: "ytPin:"` - Storage key prefix for the unified per-video record
- `PIN_MAX: 5000` - LRU cap on stored video records
- `PRUNE_CHECK_EVERY: 200` - Newly learned records before a prune scan runs
- `GRID_DEBOUNCE_MS: 300` - Debounce delay for grid list mutations
- `GRID_RESYNC_DEBOUNCE_MS: 800` - Delay for resyncing observers after layout changes
- `NAV_APPLY_DEBOUNCE_MS: 64` - Debounce for navigation-based title application
- `PLAYER_RETRY_MS: [0, 300]` - Bounded safety-net retries for watch/Shorts (primary trigger is events)
- `GRID_SCAN_CAP: 800` - Maximum grid anchors to scan per pass

### Observer Strategy
- **Subtree observers** watch `#contents`, miniplayer, Shorts, and `#primary-inner` (not `#secondary`)
- **App structure observer** watches `ytd-app` childList to resync subtree observers when layout changes
- **Filtering**: Skips player subtree mutations and comments/live chat under `#primary-inner`

### Chrome vs Firefox Manifests
- Root `manifest.json` uses Firefox format (`background.scripts`)
- Build process generates Chrome variant in `dist/chrome-unpacked/` with `background.service_worker`
- This separation is required because Chrome rejects `background.scripts` and Firefox rejects `service_worker`

## Testing Approach

E2E tests use Playwright with Chromium loading the extension as unpacked. Tests focus on pin invariants rather than asserting A/B title or thumbnail behavior (since YouTube doesn't flip titles or thumbnails on every refresh):

1. **Round-trip** - First title seen is shown again after full navigation
2. **Same-page stability** - Watch title text remains unchanged across several seconds
3. **SPA navigation** - In-page navigation shows different titles for different videos
4. **Grid thumbnail round-trip** - First thumbnail seen for a grid/sidebar card is shown again after full navigation
5. **Grid thumbnail SPA navigation** - In-page navigation shows different thumbnails for different videos

(Watch pages pin the title only — the player occupies the thumbnail area.)

Pure helpers in `content.js` are also covered by fast `node:test` unit tests (`npm run test:unit`): title/thumbnail validation, video-id extraction, record merge, and LRU eviction.

Tests require headed browser (extensions don't load in headless mode). For CI, use Xvfb or `npm run test:e2e:ci`.

## Important Constraints

- **No continuous observers on watch title**: React to `yt-page-data-updated` / `yt-navigate-finish` events (not a live observer) to avoid fighting YouTube's UI and prevent stuck/flickering titles
- **Generation guards**: Both `applyPlayer` and `applyGridLocks` bump a generation counter and bail if a newer pass started during their `await`; `applyPlayer` also re-checks the URL still matches the captured id
- **Grid recycling guard**: Re-verify `cardVideoId(card) === capturedId` before writing, because YouTube reuses card DOM nodes for different videos during virtualized scroll
- **Learn-when-settled (watch)**: Only save a native title that matches `document.title`, so the previous video's title is never pinned under the new id
- **Exclude #secondary from subtree observers**: Sidebar recommendations mutate constantly; sidebar tiles are still scanned when grid locks run via other triggers
- **Text node mutation**: Updates text nodes directly rather than replacing `textContent` to preserve component structure
- **No watch-page thumbnail pin**: The player occupies that area; thumbnails are pinned only in grids/sidebar
- **Storage record**: One `ytPin:<id> = { t, th, ts }` record per video; LRU-pruned to `PIN_MAX`
- **Video ID validation**: Uses regex `/[a-zA-Z0-9_-]{11}/` for YouTube video IDs
- **Unit tests**: Pure helpers are exported from `content.js` under a `module.exports` guard and tested via `npm run test:unit` (`node:test`)

## Store Submission

When preparing for store submission:
- Bump `version` in `manifest.json`
- Run `npm run build:amo` for Firefox (upload ZIP from `dist-amo/`)
- Run `npm run build:chrome-unpacked` then zip contents of `dist/chrome-unpacked/` for Chrome
- Keep Firefox add-on ID `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}` unchanged after first AMO submission
- Host PRIVACY.md at a public URL for both stores