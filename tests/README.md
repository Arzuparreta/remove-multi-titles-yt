# Tests

## Unit (`npm run test:unit`)

Fast `node:test` suites, no browser:

- `unit/main-core.test.js` — the MAIN-world core of `content-main.js` against **real YouTube JSON** in `fixtures/` (watch page, player, `get_watch`, `next`, search, channel videos/Shorts, Shorts page, `reel_item_watch`, YouTube Music): which renderers are learned from or only patched, "Up next" / first-frame / playlist traps, thumbnail variants, the streaming transform (chunk boundaries, per-element streaming, abort).
- `unit/pin-helpers.test.js` — the pin store in `content.js`: first-seen learning, cross-tab merge, LRU, Music namespace, schema v3 migration.
- `unit/manifest-runtime.test.js` — manifest wiring and the Chrome build.

When YouTube changes its JSON, refresh the fixtures with `npm run capture:fixtures` (logged-out, es-ES) and fix `HANDLERS` in `content-main.js` until the suite passes again.

## E2E in Chromium (`npm run test:e2e`)

Playwright loads `dist/chrome-unpacked` into a **persistent** Chromium profile (extensions do not load in Playwright's default contexts) in the new headless mode, so no display or Xvfb is needed. `HEADED=1` shows the browser; `PW_CHROMIUM_PATH` picks another binary. The EU consent screen is skipped with a `SOCS` cookie. Fixtures live in `support/fixtures.cjs` (`withExtension`, `preloadPins`, `seed`, `extraExtensions`).

- `pin-apply.spec.js` — simulated A/B test: a seeded title pin must show on search cards, on the watch page reached by SPA navigation (`get_watch`), in the player and tab title, and survive `updated_metadata`; a seeded thumbnail variant that no longer exists on the CDN must heal back to YouTube's thumbnail and be forgotten. (Variant rewriting itself is unit-tested.)
- `nav-integrity.spec.js` — runs **with and without** the extension: time until the player plays each video (watch → watch via sidebar and channel pages, Shorts swipes) and leaks (metadata from a previous view still on screen). 5000 synthetic pins are preloaded.
- `multi-title-pin.spec.js` — round-trip and same-page stability of the watch title.
- `search-recycle.spec.js` — search → search must not leak titles between results.
- `coexistence.spec.js` — with `support/other-extension` (injects a page script like YouTube Anti Translate) loaded too: that extension's own InnerTube request returns YouTube's original data while the page's request gets the pin.

YouTube does not A/B test on demand, so tests assert pin invariants (and seed pins to simulate a test) rather than waiting for a real variant.

## Firefox (`npm run test:firefox`)

Playwright cannot load extensions into Firefox, so `scripts/firefox-nav-check.mjs` drives the system Firefox over WebDriver BiDi and installs the extension as a temporary add-on (a throwaway seeder adds `--preload` pins and a control pin for the first video). It reports whether the control pin is applied, then runs the watch-navigation walk plus normal reloads. Options: `--no-ext` (baseline), `--ext <dir>` (another build), `--debug` (print the extension's `[ytpin]` log), `--also tests/support/other-extension` (coexistence check), `--headed`.
