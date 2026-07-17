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

### Core Design Philosophy (hybrid: interception + DOM safety net)
Two content scripts cooperate across worlds:

1. **`content-main.js` (MAIN world, `document_start`)** — the anti-flicker layer. It patches page-owned surfaces an isolated script cannot reach — `fetch`, `XMLHttpRequest`, and the `ytInitialData` / `ytInitialPlayerResponse` globals — and rewrites the first-seen title/thumbnail into InnerTube responses **before YouTube renders them**. All pin lookups are **synchronous** against a local cache mirror, so nothing blocks `fetch` resolution and there is no per-response IPC.
2. **`content.js` (ISOLATED world, `document_start`)** — the storage authority + safety net. It owns `browser.storage.local`, is the single place that persists/prunes/migrates pins, mirrors the cache into the MAIN world, and runs a hardened **DOM reconciler** (apply-only) for surfaces interception missed (Chrome `document_start` races, XHR getter-override failures, already-rendered DOM).

Interception is reliable on Firefox (MAIN `document_start` runs before page scripts); on Chrome the race is not guaranteed, so the DOM reconciler is the guarantee of eventual correctness.

### Cross-world bridge (postMessage)
- **ISOLATED → MAIN**: `SET_CACHE` (full snapshot on startup) and `PATCH_CACHE` (deltas, incl. `enabled`). Emitted after migration/load and on every `storage.onChanged`.
- **MAIN → ISOLATED**: `HELLO` (request snapshot; covers either load order) and `LEARN` (fire-and-forget first-seen values). ISOLATED merges LEARN conservatively (`learnMerge`) and never clobbers an existing title or a different thumbnail variant.
- MAIN updates its mirror **optimistically** on learn so a just-learned pin applies to the next response immediately; the canonical record converges via the commit's `storage.onChanged` → `PATCH_CACHE`.

### Key Components

**content-main.js** (MAIN world):
- **Synchronous apply/learn** (`processEntries`): reads the local mirror, mutates response objects in place, and queues `LEARN` messages. Never awaits.
- **Interception traps**: `patchFetch` (rebuilds the `Response` only when modified), `patchXHR` (lazy `responseText`/`response` getter overrides so any listener order sees the rewrite; handles `responseType: "json"` in place), `trapWindowProperty` (mutates `ytInitialData`/`ytInitialPlayerResponse` **synchronously in the setter**).
- **Collection + classification** (`collectVideoEntries`, `classify`): walks InnerTube JSON tracking the wrapping renderer key. Learns titles+thumbs only from canonical **video** renderers, titles-only from **short** renderers, and **skips** playlist/mix/podcast/endscreen. `readVideoId` is strict (exactly 11 chars; playlist `contentId`s rejected).
- **Thumbnail variants** (`parseThumb`, `buildBaseThumb`, `writeThumbToObj`): pins the A/B variant identity (`_custom_N`), not a frozen URL. Reverting to the original yields clean **param-less** base URLs (never expire); custom variants reuse the stored URL and refresh `sqp`/`rs` when re-seen.

**content.js** (ISOLATED world):
- **Storage layer**: one record per video, `ytPin:<id> = { t, th, ts }`. `learnMerge` (conservative) for bridge learns; `mergeRecord` (permissive) for migration folds. Debounced commit (`scheduleCommit` / `flushCommit`) with LRU pruning (`selectKeysToEvict`).
- **Cache authority + bridge**: `sendFullCache` / `sendPatch` / `handleLearn`; `storage.onChanged` keeps the cache and the MAIN mirror in sync across tabs.
- **DOM reconciler** (`reconcileDom`, apply-only): scans grid/sidebar/watch roots; **re-verifies `cardVideoId(card)` before writing** (recycling guard); never cross-applies a horizontal thumbnail onto a Shorts slot; Trusted-Types-safe writes (`setPinnedTitleText` text-node mutation, `setPinnedThumbnail` variant-aware with an `onerror` revert to native).
- **Watch/Shorts title** (`applyWatchTitle`): event-driven (no continuous observer on the watch title).
- **Migration**: one-time fold of legacy `ytTitleLock:` / `ytThumbLock:` keys into `ytPin:` records, gated by `ytPinSchema`; all apply paths `await migrationReady`.

**background.js** — minimal background script (Firefox) / service worker (Chrome); relays `webNavigation.onHistoryStateUpdated` as a SPA-nav signal.

### Important Constants (content.js)
- `PIN_PREFIX: "ytPin:"` / `PIN_MAX: 5000` / `PRUNE_CHECK_EVERY: 200` — storage record + LRU.
- `RECONCILE_DEBOUNCE_MS: 300` — trailing-edge throttle for the DOM reconciler (cannot be starved by continuous mutation).
- `RESYNC_DEBOUNCE_MS: 800` — re-attach observers after a layout swap.
- `COMMIT_DEBOUNCE_MS: 500` — min gap between storage commits.
- `DOM_SCAN_CAP: 200` (cards applied) / `DOM_LINK_CAP: 1500` (anchors examined) per pass.

### Observer Strategy
- **Subtree observers** watch only the infinite-scroll grid feeds (`#contents`, `ytd-shorts`) with a trailing-edge throttle; comments/live chat/player (`#primary-inner`) and the sidebar (`#secondary`) are covered by interception + event-driven reconciles instead.
- **Resync** (`scheduleResync`) re-attaches observers on `yt-navigate-finish` / `yt-page-data-updated` when YouTube swaps the layout.

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

Pure helpers in `content.js` and `content-main.js` are covered by fast `node:test` unit tests (`npm run test:unit`): title/thumbnail validation, strict video-id extraction, source classification, thumbnail-variant swap, conservative learn-merge, record merge, and LRU eviction.

Tests require headed browser (extensions don't load in headless mode). For CI, use Xvfb or `npm run test:e2e:ci`.

## Important Constraints

- **Interception must never block YouTube**: MAIN-world lookups are synchronous against the local mirror; `fetch`/XHR are not held behind any IPC round-trip. Rebuild a `Response` (or override XHR getters) only when a pin actually changed the body.
- **ISOLATED is the only storage writer**: the MAIN world never touches `browser.storage`; it learns via fire-and-forget `LEARN` and reads via `SET_CACHE`/`PATCH_CACHE`.
- **Conservative learning (anti-leak)**: `learnMerge` fills only missing fields and refreshes a thumbnail only for the *same* A/B variant — an existing title or a different variant is never clobbered. Learn only from canonical **video**/**short** renderers; **skip** playlist/mix/podcast/endscreen.
- **Strict video id**: exactly 11 chars (`/^[a-zA-Z0-9_-]{11}$/`); playlist/collection `contentId`s are rejected so a playlist is never pinned as a video.
- **Thumbnail variants, not frozen URLs**: pin the `_custom_N` identity and preserve each slot's resolution; original-variant pins produce param-less URLs that never expire; a stale custom pin reverts to native via `onerror`.
- **No Shorts↔video thumbnail cross-apply**: a vertical Shorts thumbnail is never written onto the same video's horizontal cards (titles are still pinned for both).
- **DOM reconciler is apply-only**: it never learns (learning happens in the interception layer, which sees structured, classified data). Re-verify `cardVideoId(card) === capturedId` before writing (YouTube recycles card DOM during virtualized scroll).
- **No continuous observer on the watch title**: `applyWatchTitle` is event-driven (`yt-navigate-finish` / `yt-page-data-updated`).
- **Trusted-Types-safe DOM writes**: text-node mutation and `img.src` only — never `innerHTML` (YouTube enforces Trusted Types).
- **No watch-page thumbnail pin**: the player occupies that area; thumbnails are pinned only in grids/sidebar.
- **Storage record**: one `ytPin:<id> = { t, th, ts }` record per video; LRU-pruned to `PIN_MAX`.
- **Unit tests**: pure helpers are exported from both `content.js` and `content-main.js` under a `module.exports` guard (bootstrap is guarded for non-browser envs) and tested via `npm run test:unit`.

## Store Submission

When preparing for store submission:
- Bump `version` in `manifest.json`
- Run `npm run build:amo` for Firefox (upload ZIP from `dist-amo/`)
- Run `npm run build:chrome-unpacked` then zip contents of `dist/chrome-unpacked/` for Chrome
- Keep Firefox add-on ID `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}` unchanged after first AMO submission
- Host PRIVACY.md at a public URL for both stores