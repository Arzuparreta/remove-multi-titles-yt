# remove-multi-titles-yt


[**Get for Firefox**](https://addons.mozilla.org/en-US/firefox/addon/remove-multi-titles-youtube) | [**Get for Chrome**](https://chromewebstore.google.com/detail/remove-multi-titles-youtu/gahcfhkfmbmfbmchbcepecigldgokkif)

YouTube sometimes A/B tests different titles for the same video. This extension remembers the first title you see for each video and keeps showing that one in the player and in lists (home, subscriptions, search results, related videos, etc.), so you are not bounced between variants or re-clickbaited by a renamed tile.

It only runs on youtube.com. Thumbnails are unchanged; only title text is adjusted where the extension can match a video to a stored title.

## How it works 

The first time you see a title for a video (watch page, Shorts, or a grid tile), it is saved locally. Later, that same string is shown again for that video id. Updates run **after navigation** (`yt-navigate-finish`, URL changes) with a few short retries so metadata can mount — there is **no** continuous MutationObserver on the big watch title, which avoided fighting YouTube’s UI. Nothing is sent to a server.

## Architecture 

| Area | Behaviour |
|------|-----------|
| Watch / Shorts | Apply pin or save first-seen **once per navigation**, with bounded retries (`PLAYER_RETRY_MS`), not a live DOM fight. |
| Lists / grids | Debounced subtree observers on `#contents`, miniplayer, Shorts, and `#primary-inner` (not `#secondary`) so sidebar churn does not constantly re-run pin passes. Sidebar tiles are still included when locks run (navigation, history message, other roots). |
| Video id | YouTube `yt-navigate-finish` detail when present; otherwise URL (`?v=` / Shorts path). |

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


