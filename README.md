# remove-multi-titles-yt


[**Get for Firefox**](https://addons.mozilla.org/firefox/addon/remove-multi-titles-youtube) | [**Get for Chrome**](https://chromewebstore.google.com/detail/remove-multi-titles-youtu/gahcfhkfmbmfbmchbcepecigldgokkif)

YouTube A/B tests titles and thumbnails ("Test & compare"), auto-translates titles, and creators rename videos after publishing. This extension remembers the first title and thumbnail you see for each video and keeps showing exactly those — in lists (home, subscriptions, search, channel pages, related videos, playlists), on the watch page, in the player, in the tab title, in Shorts and in YouTube Music — so you are not bounced between variants or re-clickbaited by a renamed tile.

It only runs on youtube.com. Nothing is sent anywhere.

## How it works

Instead of fighting YouTube's page after it has rendered, the extension rewrites the data YouTube loads (its InnerTube JSON and the initial page data) before YouTube renders it, so YouTube itself draws the pinned title and thumbnail. That means no flicker and no mix-ups when YouTube recycles cards while you scroll.

It is built to never get in YouTube's way: pins are looked up synchronously from memory, responses keep streaming (the video starts as soon as YouTube's player data arrives), aborted requests stay aborted, unchanged responses are passed through byte for byte, and anything unexpected is left untouched.

| Area | Behaviour |
|------|-----------|
| Lists / grids / sidebar | Title and thumbnail pinned from YouTube's JSON (lockups, search results, playlists, Shorts shelves, end screens, autoplay). |
| Watch page | Title pinned in the heading, the player, the tab title and the description panel, including YouTube's live `updated_metadata` refresh. |
| Shorts | Title and vertical thumbnail pinned. |
| Thumbnails | A thumbnail is only replaced when YouTube serves a *different variant* (e.g. `hq720_custom_2.jpg`); sizes and Shorts/landscape art are never mixed. |
| YouTube Music | Pinned separately (Music shows song titles for the same video ids). |
| Storage | `browser.storage.local`, one record per video (`ytPin:<id>`), least-recently-seen pruned beyond 5000 videos. The popup shows how many videos are pinned and can clear them. |

### Install from source (Chrome / Chromium)

The repo root is the Firefox package; `npm run build:chrome-unpacked` copies the same files into a clean folder for Chrome.

1. Download or clone this repo and run `npm ci` (or at least `npm run build:chrome-unpacked`).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**.
3. Select **`dist/chrome-unpacked`** (created by `npm run build:chrome-unpacked`), not the repo root.

To update after pulling changes: run `npm run build:chrome-unpacked` again, then **Reload** the extension in Chrome.

### Install from source (Firefox)

For normal use, install from Mozilla Add-ons (use the **Get the add-on** image at the top).

1. Download or clone this repo.
2. Open `about:debugging`.
3. Click **This Firefox** (left sidebar).
4. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose **`manifest.json`** in the project directory.

Temporary add-ons are removed when Firefox closes; load again if you need it back.

## Development

```bash
npm ci
npm run test:unit      # extractors vs. real captured YouTube JSON, pin store, migration
npm run test:e2e       # Playwright + Chromium (headless, extension loaded)
npm run test:firefox   # real Firefox over WebDriver BiDi (add --no-ext for a baseline)
```

Debug logging: on youtube.com run `localStorage.setItem("ytpin:debug", "1")` in the console and reload.
