# Store submission checklist (Chrome Web Store + Firefox Add-ons)

Use this when you are ready to publish. The repo includes **`icons/*.png`** (16–512) plus **`action.default_icon`** in `manifest.json`. Regenerate from the source JPEG with **`npm run build:icons`**.

## Release (GitHub Actions builds the ZIPs)

Bump `version` in `manifest.json`, commit, then push a matching tag:

```bash
git tag v3.0.1 && git push origin v3.0.1
```

The **Build** workflow (`.github/workflows/build.yml`) runs the unit tests and `web-ext lint`, builds both ZIPs from a clean checkout and publishes a GitHub Release with them attached (Firefox AMO ZIP + Chrome Web Store ZIP, release notes generated from the merged PRs). It refuses tags that do not match the manifest version. Every push to `main` and every PR also builds the ZIPs and keeps them under the run's **Artifacts** (`extension-zips`).

Download the assets from the release and upload them to each store.

## Build the ZIP locally (do not hand-zip the repo)

**Firefox (AMO)** uses the root `manifest.json`. The repo includes **`web-ext-config.mjs`** so the AMO package is reproducible. **`dist-amo/` is gitignored**.

```bash
git clone <repo-url> && cd remove-multi-titles-yt
npm ci
npm run build:amo
```

Upload the ZIP under **`dist-amo/`** to AMO. A local build includes any untracked file in the repo that `web-ext-config.mjs` does not ignore; the CI build does not.

**Chrome Web Store**: run **`npm run build:chrome-zip`** and upload `dist/remove-multi-titles-yt-chrome-<version>.zip`. It contains the same files; its manifest only drops the Firefox-only `browser_specific_settings` key.

Checklist:

- [x] Icon PNGs under `icons/` and `icons` / `action` keys in `manifest.json` (see `npm run build:icons`).
- [ ] Bump `version` in `manifest.json` when you ship an update.
- [ ] Push the `v<version>` tag (or run `npm run build:amo` locally)—do not zip the whole project folder; that would include junk and can fail validation.

## Public privacy policy URL

Both stores ask for a link to your privacy policy.

1. Host [PRIVACY.md](PRIVACY.md) at a **public URL**, for example:
   - Raw GitHub: `https://raw.githubusercontent.com/Arzuparreta/remove-multi-titles-yt/main/PRIVACY.md`, or  
   - [GitHub Pages](https://pages.github.com/) serving the same text as HTML, or  
   - Any page on a domain you control.

2. Paste that URL into the Chrome and Firefox developer dashboards.

## Firefox add-on ID (do not change after first listing)

`manifest.json` sets `browser_specific_settings.gecko.id` to `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}`. **Keep this ID forever** after your first AMO submission; changing it makes updates look like a different add-on.

## Copy-paste: single purpose (short)

> Pins the first title and thumbnail you see for each YouTube video — in lists, on the watch page, in Shorts and in the player — so YouTube's title/thumbnail A/B tests and later renames don't keep changing them on your screen.

## Copy-paste: permission justifications

**`storage`**

> Saves the pinned title and thumbnail address per video ID only on your device. Nothing is sent to external servers.

**Host permission `*://*.youtube.com/*`**

> Needed so the extension can run on YouTube and replace titles/thumbnails in the data YouTube loads for its own pages. It does not access other sites.

## Copy-paste: data / user privacy (summary)

> No personal data is collected. Pinned titles and thumbnail addresses are stored locally in the browser. No analytics, accounts, or remote servers.

## Chrome Web Store extras

- Screenshots and promotional images are uploaded in the **dashboard**, not bundled in the ZIP (unless you choose to).
- You may need a developer account and a one-time registration fee (see current Google policies).

## Firefox Add-ons extras

- Mozilla signs listed add-ons after upload. Local `web-ext build` only creates the unsigned ZIP for submission. Temporary add-on loading is only for development.

## Project links

- Repository: https://github.com/Arzuparreta/remove-multi-titles-yt  
- Update `homepage_url` in `manifest.json` if the canonical URL changes.
