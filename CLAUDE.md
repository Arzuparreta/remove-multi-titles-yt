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
The extension avoids fighting YouTube's UI by not attaching continuous MutationObservers to the watch title or thumbnail area. Instead, it applies title and thumbnail pins once per navigation with bounded retries, and uses debounced subtree observers for grid lists.

### Key Components

**content.js** - Main extension logic:
- **Watch/Shorts handling**: Applies title and thumbnail pin or saves first-seen title and thumbnail once per navigation using `PLAYER_RETRY_MS` delays (0, 150, 400, 900ms)
- **Grid/List handling**: Debounced subtree observers on `#contents`, miniplayer, Shorts, and `#primary-inner` (excludes `#secondary` to avoid constant re-runs from sidebar churn)
- **Video ID extraction**: Prefers YouTube's `yt-navigate-finish` event detail, falls back to URL parsing (`?v=` or Shorts path)
- **Title text updates**: Mutates text nodes in place (including open shadow subtrees) rather than assigning `textContent`, which preserves internal structure and layout
- **Thumbnail updates**: Updates thumbnail URLs by modifying `img` src attributes or `background-image` CSS properties

**background.js** - Minimal background script (Firefox) or service worker (Chrome) for extension lifecycle

### Important Constants
- `STORAGE_PREFIX: "ytTitleLock:"` - Storage key prefix for titles
- `THUMB_STORAGE_PREFIX: "ytThumbLock:"` - Storage key prefix for thumbnails
- `GRID_DEBOUNCE_MS: 300` - Debounce delay for grid list mutations
- `GRID_RESYNC_DEBOUNCE_MS: 800` - Delay for resyncing observers after layout changes
- `NAV_APPLY_DEBOUNCE_MS: 64` - Debounce for navigation-based title and thumbnail application
- `PLAYER_RETRY_MS: [0, 150, 400, 900]` - Retry timings for watch/Shorts title and thumbnail application
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
4. **Thumbnail round-trip** - First thumbnail seen is shown again after full navigation
5. **Thumbnail same-page stability** - Watch thumbnail remains unchanged across several seconds
6. **Thumbnail SPA navigation** - In-page navigation shows different thumbnails for different videos

Tests require headed browser (extensions don't load in headless mode). For CI, use Xvfb or `npm run test:e2e:ci`.

## Important Constraints

- **No continuous observers on watch title or thumbnail**: Avoids fighting YouTube's UI and prevents stuck/flickering titles and thumbnails
- **Exclude #secondary from subtree observers**: Sidebar recommendations mutate constantly; sidebar tiles are still scanned when grid locks run via other triggers
- **Text node mutation**: Updates text nodes directly rather than replacing `textContent` to preserve component structure
- **Thumbnail URL updates**: Updates `img` src attributes or `background-image` CSS properties directly
- **Storage prefix**: Title keys use `ytTitleLock:` prefix, thumbnail keys use `ytThumbLock:` prefix
- **Video ID validation**: Uses regex `/[a-zA-Z0-9_-]{11}/` for YouTube video IDs

## Store Submission

When preparing for store submission:
- Bump `version` in `manifest.json`
- Run `npm run build:amo` for Firefox (upload ZIP from `dist-amo/`)
- Run `npm run build:chrome-unpacked` then zip contents of `dist/chrome-unpacked/` for Chrome
- Keep Firefox add-on ID `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}` unchanged after first AMO submission
- Host PRIVACY.md at a public URL for both stores