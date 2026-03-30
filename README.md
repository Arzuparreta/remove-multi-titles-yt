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

The first time you open a video, the title you see is saved locally. Next visits reuse that string. Nothing is sent to a server.

## Automated tests (Playwright)

Chromium is launched **with this folder as the unpacked extension** so you can reproduce title bugs without clicking through your daily browser. See [tests/README.md](tests/README.md): `npm install`, then `npm run test:e2e`. If your terminal has **no `DISPLAY`** (common in SSH or some IDE terminals), install **Xvfb** (`sudo pacman -S xorg-server-xvfb` on Arch/CachyOS) so the script can use a virtual screen; or run from a normal desktop terminal.

---

The extension will be published on the official Chrome Web Store and Firefox Add-ons (AMO) when it is ready; until then, use the steps above.

## Before store submission

- Follow **[STORE_SUBMISSION.md](STORE_SUBMISSION.md)** (ZIP layout, privacy URL, copy-paste text for reviewers).
- Host **[PRIVACY.md](PRIVACY.md)** at a public URL for both stores.
- License: **[LICENSE](LICENSE)** (MIT). Third-party: **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)**.
- **Icons:** add your PNGs and an `icons` entry in `manifest.json` when the artwork is ready (required for typical store uploads).
