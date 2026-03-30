# Store submission checklist (Chrome Web Store + Firefox Add-ons)

Use this when you are ready to publish. **Icons are not in the repo yet**—add PNGs and an `icons` block in `manifest.json` before final upload if the store requires package icons (Chrome typically does).

## Before you zip the extension

- [ ] Add icon files (e.g. `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`) and add an `icons` key to `manifest.json`.
- [ ] Bump `version` in `manifest.json` when you ship an update.
- [ ] **Do not** include `.git` inside the ZIP. Include: `manifest.json`, `content.js`, `background.js`, `lib/`, `LICENSE`, `THIRD_PARTY_NOTICES.md` (and optionally `PRIVACY.md` for your records—the stores need a **hosted URL**, not only the file in the zip).

## Public privacy policy URL

Both stores ask for a link to your privacy policy.

1. Host [PRIVACY.md](PRIVACY.md) at a **public URL**, for example:
   - Raw GitHub: `https://raw.githubusercontent.com/Arzuparreta/remove-multi-titles-yt/main/PRIVACY.md` (adjust branch/name if different), or  
   - [GitHub Pages](https://pages.github.com/) serving the same text as HTML, or  
   - Any page on a domain you control.

2. Paste that URL into the Chrome and Firefox developer dashboards.

## Firefox Add-ons (AMO) — minified code

This package includes **minified** third-party code: `lib/browser-polyfill.min.js`. If the reviewer asks for provenance, point them to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the linked Mozilla repository.

## Firefox add-on ID (do not change after first listing)

`manifest.json` sets `browser_specific_settings.gecko.id` to `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}`. **Keep this ID forever** after your first AMO submission; changing it makes updates look like a different add-on.

## Copy-paste: single purpose (short)

> Pins the first title you see for each YouTube video on the watch and Shorts player pages so YouTube cannot keep switching the title for the same video on your screen.

## Copy-paste: permission justifications

**`storage`**

> Saves the pinned title text per video ID only on your device. Nothing is sent to external servers.

**Host permission `*://*.youtube.com/*`**

> Needed so the extension can run only on YouTube and adjust the title element on watch and Shorts pages. It does not access other sites.

## Copy-paste: data / user privacy (summary)

> No personal data is collected. Pinned titles are stored locally in the browser. No analytics, accounts, or remote servers.

## Chrome Web Store extras

- Screenshots and promotional images are uploaded in the **dashboard**, not bundled in the ZIP (unless you choose to).
- You may need a developer account and a one-time registration fee (see current Google policies).

## Firefox Add-ons extras

- You will sign the package (Mozilla’s flow or web-ext). Temporary add-on loading is only for development.

## Project links

- Repository: https://github.com/Arzuparreta/remove-multi-titles-yt  
- Update `homepage_url` in `manifest.json` if the canonical URL changes.
