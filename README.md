# remove-multi-titles-yt

<p>
  <a href="https://addons.mozilla.org/en-US/firefox/addon/remove-multi-titles-youtube/"><img src="https://blog.mozilla.org/addons/files/2015/11/get-the-addon.png" alt="Get the add-on for Firefox" width="109" height="38"></a>
</p>

YouTube sometimes A/B tests different titles for the same video. This extension remembers the first title you see for each video and keeps showing that one in the player and in lists (home, subscriptions, search results, related videos, etc.), so you are not bounced between variants or re-clickbaited by a renamed tile.

It only runs on youtube.com. Thumbnails are unchanged; only title text is adjusted where the extension can match a video to a stored title.

## Install from source (Chrome / Chromium)

Chrome Manifest V3 only allows a **service worker** background. Firefox (and `web-ext` builds for AMO) use **`background.scripts`**, which Chrome rejects—so this repo keeps **Firefox** `manifest.json` at the project root and generates a Chrome bundle.

1. Download or clone this repo and run `npm ci` (or at least `npm run build:chrome-unpacked`).
2. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**.
3. Select **`dist/chrome-unpacked`** (created by `npm run build:chrome-unpacked`), not the repo root.

To update after pulling changes: run `npm run build:chrome-unpacked` again, then **Reload** the extension in Chrome.

## Install from source (Firefox)

For normal use, install from Mozilla Add-ons (use the **Get the add-on** image at the top).

1. Download or clone this repo.
2. Open `about:debugging`.
3. Click **This Firefox** (left sidebar).
4. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose **`manifest.json`** in the project directory (Firefox expects `background.scripts`, not `service_worker`, in that file).

Temporary add-ons are removed when Firefox closes; load again if you need it back.

## How it works (short)

The first time you see a title for a video (watch page, Shorts, or a grid tile), it is saved locally. Later, that same string is shown again for that video id. Updates run **after navigation** (`yt-navigate-finish`, URL changes) with a few short retries so metadata can mount — there is **no** continuous MutationObserver on the big watch title, which avoided fighting YouTube’s UI. Nothing is sent to a server.

### Architecture (v2)

| Area | Behaviour |
|------|-----------|
| Watch / Shorts | Apply pin or save first-seen **once per navigation**, with bounded retries (`PLAYER_RETRY_MS`), not a live DOM fight. |
| Lists / grids | Debounced subtree observers on `#contents`, miniplayer, Shorts, and `#primary-inner` (not `#secondary`) so sidebar churn does not constantly re-run pin passes. Sidebar tiles are still included when locks run (navigation, history message, other roots). |
| Video id | YouTube `yt-navigate-finish` detail when present; otherwise URL (`?v=` / Shorts path). |

## E2E tests (Playwright)

Optional. Loads this folder as the unpacked extension and checks **pin invariants** (same title after A→B→A, stability over several seconds on one page). YouTube does not A/B every video on every refresh, so tests do not assert “two variants appeared” — see [tests/README.md](tests/README.md).

```bash
npm install
npm run test:e2e
```

Without a display (SSH/CI), use `npm run test:e2e:ci` or install Xvfb and use `scripts/run-playwright-e2e.sh`.

---

The Firefox build is [published on Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/remove-multi-titles-youtube/). The Chrome Web Store version is still pending review.

## Build the Firefox / AMO upload ZIP (any computer)

The upload file is **not stored in git** on purpose: it is generated from the tracked source so every machine (and every tag) gets a clean package.

**On your machine**

```bash
git clone https://github.com/Arzuparreta/Arzuparreta.git
cd Arzuparreta/projects/repos/remove-multi-titles-yt
npm ci
npm run build:amo
```

The ZIP appears under **`dist-amo/`** (name includes the version from `manifest.json`, e.g. `remove_multi_titles_youtube_-2.0.0.zip`). Upload that file to [addons.mozilla.org](https://addons.mozilla.org/developers/).

**Without installing anything locally**

After this workflow is on the default branch: open the repo on GitHub → **Actions** → **Build AMO package** → **Run workflow**. When the run finishes, download the **`firefox-amo-zip`** artifact from the run page.

## Before store submission

- Follow **[STORE_SUBMISSION.md](STORE_SUBMISSION.md)** (ZIP layout, privacy URL, copy-paste text for reviewers).
- Host **[PRIVACY.md](PRIVACY.md)** at a public URL for both stores.
- License: **[LICENSE](LICENSE)** (MIT). Third-party: **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**.
- **Icons:** add your PNGs and an `icons` entry in `manifest.json` when the artwork is ready (required for typical store uploads).
