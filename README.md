# remove-multi-titles-yt


[**Get for Firefox**](https://addons.mozilla.org/en-US/firefox/addon/remove-multi-titles-youtube) | [**Get for Chrome**](https://chromewebstore.google.com/detail/remove-multi-titles-youtu/gahcfhkfmbmfbmchbcepecigldgokkif)

YouTube sometimes A/B tests different titles and thumbnails for the same video. This extension remembers the first title and thumbnail you see for each video and keeps showing that one in the player and in lists (home, subscriptions, search results, related videos, etc.), so you are not bounced between variants or re-clickbaited by a renamed tile.

It only runs on youtube.com.

## How it works

The first time you see a title and thumbnail for a video (watch page, Shorts, or a grid tile), they are saved locally. Later, those same strings are shown again for that video id. Updates run **after navigation** (`yt-navigate-finish`, URL changes) with a few short retries so metadata can mount — there is **no** continuous MutationObserver on the big watch title or thumbnail, which avoided fighting YouTube’s UI. Nothing is sent to a server.

## Architecture

| Area | Behaviour |
|------|-----------|
| Watch / Shorts | Pins the **title** on YouTube's own settle signals (`yt-page-data-updated`, `yt-navigate-finish`) with a generation guard + URL re-check, plus a small bounded retry safety net (`PLAYER_RETRY_MS`). A title is only *learned* once the DOM matches `document.title`, so a stale title can't be saved under the wrong video. (The watch player shows the video itself, so no thumbnail is pinned there.) |
| Lists / grids | Debounced subtree observers on `#contents`, miniplayer, Shorts, and `#primary-inner` (not `#secondary`) so sidebar churn does not constantly re-run pin passes. Sidebar tiles are still included when locks run. Cards are re-verified against their current video id right before writing (YouTube recycles card DOM during scroll), and a per-card skip cache avoids redundant work. Pins both titles and thumbnails. |
| Video id | YouTube `yt-navigate-finish` detail when present; otherwise URL (`?v=` / Shorts path). |
| Storage | `browser.storage.local`, one record per video: `ytPin:<id> = { t, th, ts }` (title, thumbnail URL, last-write time). LRU-pruned to `PIN_MAX` (5000) videos. Legacy `ytTitleLock:` / `ytThumbLock:` keys are migrated once on upgrade. |

### Install from source (Chrome / Chromium)

Chrome Manifest V3 only allows a **service worker** background. Firefox (and `web-ext` builds for AMO) use **`background.scripts`**, which Chrome rejects—so this repo keeps **Firefox** `manifest.json` at the project root and generates a Chrome bundle.

1. Download or clone this repo and run `npm ci` (or at least `npm run build:chrome-unpacked`).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**.
3. Select **`dist/chrome-unpacked`** (created by `npm run build:chrome-unpacked`), not the repo root.

To update after pulling changes: run `npm run build:chrome-unpacked` again, then **Reload** the extension in Chrome.

### Install from source (Firefox)

For normal use, install from Mozilla Add-ons (use the **Get the add-on** image at the top).

1. Download or clone this repo.
2. Open `about:debugging`.
3. Click **This Firefox** (left sidebar).
4. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose **`manifest.json`** in the project directory (Firefox expects `background.scripts`, not `service_worker`, in that file).

Temporary add-ons are removed when Firefox closes; load again if you need it back.


