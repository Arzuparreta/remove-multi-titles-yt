# remove-multi-titles-yt

YouTube sometimes A/B tests different titles for the same video. This extension remembers the first title you see for each video and keeps showing that one in the player and in lists (home, subscriptions, search results, related videos, etc.), so you are not bounced between variants or re-clickbaited by a renamed tile.

It only runs on youtube.com. Thumbnails are unchanged; only title text is adjusted where the extension can match a video to a stored title.

## Install from source (Chrome / Chromium)

1. Download or clone this repo.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked**.
5. Pick the directory that contains `manifest.json` (the cloned repo).

To update after pulling changes: open the extension card and hit **Reload**.

## Install from source (Firefox)

1. Download or clone this repo.
2. Open `about:debugging`.
3. Click **This Firefox** (left sidebar).
4. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose `manifest.json` in the project directory.

Temporary add-ons are removed when Firefox closes; load again if you need it back.

## How it works (short)

The first time you see a title for a video (watch page, Shorts, or a grid tile), it is saved locally. Later, that same string is shown again for that video id. Updates run **after navigation** (`yt-navigate-finish`, URL changes) with a few short retries so metadata can mount — there is **no** continuous MutationObserver on the big watch title, which avoided fighting YouTube’s UI. Nothing is sent to a server.

---

The extension will be published on the official Chrome Web Store and Firefox Add-ons (AMO) when it is ready; until then, use the steps above.

## Before store submission

- Follow **[STORE_SUBMISSION.md](STORE_SUBMISSION.md)** (ZIP layout, privacy URL, copy-paste text for reviewers).
- Host **[PRIVACY.md](PRIVACY.md)** at a public URL for both stores.
- License: **[LICENSE](LICENSE)** (MIT). Third-party: **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**.
- **Icons:** add your PNGs and an `icons` entry in `manifest.json` when the artwork is ready (required for typical store uploads).
