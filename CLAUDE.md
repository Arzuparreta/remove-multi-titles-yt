# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser extension (Firefox + Chrome, MV3) that pins the first-seen title and thumbnail per YouTube video so A/B tests ("Test & compare") and later renames don't change what you see. It works by rewriting YouTube's own JSON before YouTube renders it, so lists, the watch page, Shorts, the player, the tab title and YouTube Music all show the pinned values without DOM fights. Everything is stored locally.

## Development Commands

- `npm run test:unit` — fast `node:test` suite: extractors against real captured YouTube JSON (`tests/fixtures/`), streaming transform, pin store, migration.
- `npm run test:e2e` — builds `dist/chrome-unpacked/` and runs Playwright (Chromium, new headless — no Xvfb). `HEADED=1` to watch; `PW_CHROMIUM_PATH=/path/to/chrome` to use another binary.
- `npm run test:firefox` — `scripts/firefox-nav-check.mjs`: real Firefox over WebDriver BiDi, extension installed as a temporary add-on; checks a seeded pin is applied, navigation timing and leaks (`--no-ext` baseline, `--ext <dir>` another build, `--debug` prints the extension's log, `--also tests/support/other-extension` checks coexistence). In Firefox, MAIN-world content scripts appear as `<anonymous code>` in stacks.
- `npm run capture:fixtures` — refresh `tests/fixtures/*.json` from live YouTube (do this when YouTube changes its JSON).
- `npm run build:chrome-unpacked` / `build:chrome-zip` — Chrome bundle (same files; manifest without `browser_specific_settings`).
- `npm run build:amo` / `lint:ext` — Firefox package / web-ext lint.
- Debug in a browser: `localStorage.setItem("ytpin:debug", "1")` on youtube.com, reload — logs per response (`items`, `changed`, `ms`).

## Architecture

Two content scripts, both at `document_start`, no background script:

**content-main.js (MAIN world)** — sees YouTube's data.
- Wraps `window.fetch` in a transparent `Proxy`. Only allowlisted InnerTube endpoints are touched (`ENDPOINTS`: browse, next, search, player, get_watch, updated_metadata, reel_item_watch, reel_watch_sequence, music/get_queue). Requests issued by *another* extension (an extension URL other than ours on the call stack — e.g. YouTube Anti Translate fetching original titles) pass through untouched.
- `transformResponse` returns the Response at header time like native fetch and patches the body as it streams (`createStreamPatcher`): top-level array elements (YouTube streams `get_watch` as `[{playerResponse},{watchNextResponse}]` and starts the player before the rest arrives) are forwarded one by one; other documents whole. Unchanged text is forwarded byte for byte. Abort errors the body.
- Traps `ytInitialData` / `ytInitialPlayerResponse` and patches them synchronously in the setter (queued until the pin store is ready, then patched in place).
- `collectItems` walks the JSON once and only acts on allowlisted renderer keys (`HANDLERS`). Each handler knows exactly where the id, title and thumbnails live. Items `learn` only when the id is certain (same object, or the response's agreed context id for the page's own title). Context-id renderers (watch title overlays, description header, `updateTitleAction`, Shorts title) need an unambiguous `contextVideoId`.
- `applyPins` writes only values that differ; thumbnails only when the pinned *variant* (`thumbInfo().sig`, e.g. `_custom_2`, localized `_es`) differs, never across families (landscape `h` / Shorts vertical `v` / raw frame `f`). Pinned thumbnail URLs are stored complete: custom variants 404 without their signed `sqp`/`rs` params.
- Thumbnail self-healing: a removed variant answers 404 *with* a 120×90 grey placeholder that browsers display. If an image we pointed at a pinned variant errors or loads as that placeholder, it is switched back to YouTube's URL and the thumbnail pin is forgotten (`forget` query → `forgetThumbs`).
- DOM safety net (`runDomNet`): only the watch h1 and the current Short's title, only when the player confirms the video, only if JSON could not be patched in time. No observers.

**content.js (ISOLATED world)** — owns the pin store.
- Answers `ytpin:q` CustomEvents *synchronously* from an in-memory cache (`resolveItems`): returns pins, learns first-seen values (first occurrence wins), refreshes LRU timestamps.
- Persists in the background: 1 s debounce, read-before-write so the first writer wins across tabs (`mergeStored`), flush on `pagehide`, prune to `PIN_MAX` by `ts` once over `PIN_MAX + PRUNE_SLACK`.
- `planMigration` (schema v3) folds legacy keys and cleans v2.4 data (non-video ids, raw-frame thumbnails, "titles" shared by ≥3 videos such as "Up next").

Bridge events: `ytpin:q` (MAIN→ISOLATED, JSON string), `ytpin:a` (answer), `ytpin:state` (`{ready, enabled}`). If content.js does not answer, MAIN passes responses through untouched; it never waits more than `READY_WAIT_MS` (startup only).

**popup.html/js** — on/off switch (`ytPinEnabled`), pin counter, two-step "Clear pins".

### Storage
`ytPin:<id> = { t, th, tv, ts }` — title, landscape thumbnail URL, Shorts thumbnail URL, last seen. YouTube Music pins live in `ytPin:m:<id>` because Music shows song titles for the same ids. `ytPinSchema` = 3, `ytPinEnabled`.

## Important Constraints

- **Never hold or break a response**: no async round trips in the fetch path, honour abort, keep streaming, pass through on any doubt.
- **Learn only from certain associations**: never generic "object with a videoId and a title" heuristics. `playerOverlayAutoplayRenderer.title` is the "Up next" label; `reelWatchEndpoint.thumbnail` is the first video frame; lockups with `contentType` ≠ VIDEO are playlists/mixes.
- **Learn titles from what YouTube displays**: `videoDetails.title` (player) is untranslated while lists/h1/Shorts show YouTube's auto-translation, so `videoDetails` only teaches the thumbnail (`learn: "thumb"`).
- **Never fight other extensions**: no MutationObservers, no DOM writes outside the watch-title / Short-title safety net, and other extensions' InnerTube requests are not rewritten.
- YouTube Music rows: only `playlistItemData.videoId` (song/video rows) is trusted; album/playlist rows would otherwise give their name to the first track.
- Video ids are anchored `^[A-Za-z0-9_-]{11}$`.
- When YouTube changes its JSON: `npm run capture:fixtures`, then fix `HANDLERS` until `npm run test:unit` passes.
- Pure helpers are exported under `typeof window === "undefined"` guards for `node:test`.

## Releases

The distributables are the assets of a GitHub Release built by CI:

1. Bump `version` in `manifest.json` (patch for fixes, minor for features, major for redesigns), unless the user gave one. Chrome only accepts dotted numbers, so no `-beta` suffixes.
2. `npm run test:unit` and `npm run lint:ext` must pass.
3. Commit the bump with the work it ships and push it to the work branch / PR.
4. Tag that commit and push the tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. PRs are merged with merge commits, so a tag on a PR's head stays in `main`'s history.
5. The tag triggers `.github/workflows/build.yml`: it checks the tag matches the manifest version, runs the unit tests and lint, builds both ZIPs from a clean checkout and publishes a GitHub Release with them attached (`Firefox (AMO) - vX.Y.Z`, `Chrome (Web Store) - vX.Y.Z`). Wait for it (`gh run watch <id> --exit-status`) and check the release has both assets.
6. Write the release notes in English above the generated PR list (`gh release edit vX.Y.Z --notes-file …`): a `## vX.Y.Z — <headline>` title, **Fixed** / **Changed** bullets in user terms, and an **Assets** list naming both ZIPs. See v3.0.0.
7. Reply with the release URL.

Pushes to `main` and PRs also build both ZIPs as the run artifact `extension-zips`, for testing a commit without a release. Local builds: `npm run build:amo` → `dist-amo/`, `npm run build:chrome-zip` → `dist/remove-multi-titles-yt-chrome-<version>.zip`.

## Store Submission

- Upload the release's ZIPs: the Firefox one to AMO, the Chrome one to the Chrome Web Store.
- Keep the Firefox add-on ID `{a7b3c9d2-4e1f-4a8b-9c0d-1e2f3a4b5c6d}`.
- PRIVACY.md must stay publicly hosted for both stores.
