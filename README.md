# remove-multi-titles-yt

YouTube sometimes A/B tests different titles for the same video. This extension remembers the first title you see for each video (on the watch page and Shorts) and keeps showing that one, so you are not bounced between variants.

It only runs on youtube.com. It does not touch thumbnails or titles in the home feed—just the player page.

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
4. Under **Temporary Extensions**, click **Load Temporary Add-on…** and choose `manifest.json` in the project folder.

Temporary add-ons are removed when Firefox closes; load again if you need it back.

## How it works (short)

The first time you open a video, the title you see is saved locally. Next visits reuse that string. Nothing is sent to a server.

---

The extension will be published on the official Chrome Web Store and Firefox Add-ons (AMO) when it is ready; until then, use the steps above.
