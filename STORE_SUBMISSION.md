# Store submission checklist (Chrome Web Store + Firefox Add-ons)

Use this when you are ready to publish. The repo includes **`icons/*.png`** (16–512) plus **`action.default_icon`** in `manifest.json`. Regenerate from the source JPEG with **`npm run build:icons`**.

## Build the ZIP (do not hand-zip the repo)

**Firefox (AMO)** uses the root `manifest.json` with `background.scripts`. The repo includes **`web-ext-config.mjs`** so the AMO package is reproducible. **`dist-amo/` is gitignored**.

```bash
git clone <repo-url> && cd remove-multi-titles-yt
npm ci
npm run build:amo
```

Upload the ZIP under **`dist-amo/`** to AMO. Alternatively, run the **Build AMO package** workflow on GitHub Actions and download the **`firefox-amo-zip`** artifact.

**Chrome Web Store** requires `background.service_worker` in the manifest. After `npm ci`, run **`npm run build:chrome-unpacked`**, then zip the **contents** of **`dist/chrome-unpacked/`** (that folder’s `manifest.json` is the Chrome variant). Do not upload the Firefox ZIP to Chrome or vice versa.

Checklist:

- [x] Icon PNGs under `icons/` and `icons` / `action` keys in `manifest.json` (see `npm run build:icons`).
- [ ] Bump `version` in `manifest.json` when you ship an update.
- [ ] Run `npm run build:amo` (or the GitHub Action)—do not zip the whole project folder; that would include junk and can fail validation.

## Public privacy policy URL

Both stores ask for a link to your privacy policy.

1. Host [PRIVACY.md](PRIVACY.md) at a **public URL**, for example:
   - Raw GitHub: `https://raw.githubusercontent.com/Arzuparreta/Arzuparreta/main/projects/repos/remove-multi-titles-yt/PRIVACY.md`, or  
   - [GitHub Pages](https://pages.github.com/) serving the same text as HTML, or  
   - Any page on a domain you control.

2. Paste that URL into the Chrome and Firefox developer dashboards.

## Firefox Add-ons (AMO) — minified code

This package includes **minified** third-party code: `lib/browser-polyfill.min.js`. If the reviewer asks for provenance, point them to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the linked Mozilla repository.

## Firefox add-on ID (do not change after first listing)

`manifest.json` sets `browser_specific_settings.gecko.id` to `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}`. **Keep this ID forever** after your first AMO submission; changing it makes updates look like a different add-on.

## Copy-paste: single purpose (short)

> Pins the first title you see for each YouTube video on the player and in lists (home, search, related, etc.) so YouTube cannot keep switching the title for the same video on your screen.

## Copy-paste: permission justifications

**`storage`**

> Saves the pinned title text per video ID only on your device. Nothing is sent to external servers.

**Host permission `*://*.youtube.com/*`**

> Needed so the extension can run only on YouTube and adjust title text on the player and on list-style pages. It does not access other sites.

## Copy-paste: data / user privacy (summary)

> No personal data is collected. Pinned titles are stored locally in the browser. No analytics, accounts, or remote servers.

## Chrome Web Store extras

- Screenshots and promotional images are uploaded in the **dashboard**, not bundled in the ZIP (unless you choose to).
- You may need a developer account and a one-time registration fee (see current Google policies).

## Firefox Add-ons extras

- Mozilla signs listed add-ons after upload. Local `web-ext build` only creates the unsigned ZIP for submission. Temporary add-on loading is only for development.

## Project links

- Repository: https://github.com/Arzuparreta/Arzuparreta/tree/main/projects/repos/remove-multi-titles-yt  
- Update `homepage_url` in `manifest.json` if the canonical URL changes.
