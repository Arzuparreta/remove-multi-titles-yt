/**
 * Pins the first-seen title and thumbnail per YouTube video (watch, Shorts, grid cards)
 * to prevent A/B-test flicker.
 *
 * One engine, applied homogeneously to watch/Shorts and grid lists:
 *   - Storage: a single record per video, `ytPin:<id> = { t, th, ts }` (title, thumbUrl,
 *     last-write epoch). Reads/writes go through getPins/commitPins (one round-trip each).
 *   - reconcileTarget({ videoId, titleEl, thumbEl }, record, opts) is the only place that
 *     decides "apply the pin" vs "learn the native value". Both surfaces call it.
 *
 * Reliability (avoids "wrong title stuck on a different video"):
 *   - Watch/Shorts run on YouTube's own settle signals (yt-page-data-updated, yt-navigate-finish)
 *     with a generation guard + URL re-check, so a stale apply can never write after navigation.
 *     When learning we also require the native title to match document.title (the video has
 *     actually settled) before saving it.
 *   - Grid cards are recycled by YouTube during virtualized scroll / SPA navigation. We capture
 *     the id at scan time and RE-VERIFY the card still maps to that id right before writing
 *     (after the async storage read), skipping recycled cards.
 *
 * Performance:
 *   - One storage.get per grid pass (the unified record carries title + thumbnail).
 *   - A WeakMap<card> skip cache: cards already reconciled (same id, text/thumb already match)
 *     are dropped before the storage read, so steady-state scroll does almost no work.
 *   - Bounded TreeWalker scan (GRID_SCAN_CAP), comments/chat and player subtree rejected.
 *
 * Compatibility: title text is updated by mutating text nodes in place (incl. open shadow
 * subtrees) instead of assigning textContent, which preserves component structure. We do not
 * attach MutationObservers to the watch title (yt-page-data-updated is an event, not a
 * continuous observer) nor to #secondary (it churns constantly and can race YouTube's SPA
 * click handler); sidebar tiles are still scanned when grid passes run.
 */

const PIN_PREFIX = "ytPin:";
const SCHEMA_KEY = "ytPinSchema";
const SCHEMA_VERSION = 2;
const LEGACY_TITLE_PREFIX = "ytTitleLock:";
const LEGACY_THUMB_PREFIX = "ytThumbLock:";

/** LRU cap on stored video records; pruned back to this when exceeded. */
const PIN_MAX = 5000;
/** Run the (full-scan) prune check only after this many newly learned records. */
const PRUNE_CHECK_EVERY = 200;

const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;
const GRID_DEBOUNCE_MS = 300;
const GRID_RESYNC_DEBOUNCE_MS = 800;
const NAV_APPLY_DEBOUNCE_MS = 64;
/** Safety net only; primary watch detection is event-driven (yt-page-data-updated). */
const PLAYER_RETRY_MS = [0, 300];

/** Subtree observers: exclude #secondary (see file comment). */
const GRID_OBSERVER_ROOT_SELECTORS = ["#contents", "ytd-miniplayer", "ytd-shorts"];

/** Anchor scan roots: #secondary first so cap still covers watch sidebar when #contents is huge. */
const GRID_SCAN_ROOT_SELECTORS = ["#secondary", "#contents", "ytd-miniplayer", "ytd-shorts"];

const GRID_CARD_TAGS = new Set([
  "YTD-RICH-ITEM-RENDERER",
  "YTD-VIDEO-RENDERER",
  "YTD-GRID-VIDEO-RENDERER",
  "YTD-COMPACT-VIDEO-RENDERER",
  "YTD-RICH-GRID-MEDIA",
  "YTD-REEL-ITEM-RENDERER",
  "YTD-MOVIE-RENDERER",
  "YTD-PLAYLIST-VIDEO-RENDERER",
  "YTD-CHANNEL-VIDEO-RENDERER",
  "YTD-PLAYLIST-PANEL-VIDEO-RENDERER",
]);

const GRID_SCAN_CAP = 800;

/**
 * Under #primary-inner only: skip comments/live chat in TreeWalker scans and in the
 * subtree observer filter so heavy comment/chat DOM does not schedule grid passes.
 */
const PRIMARY_INNER_IGNORE_SEL =
  "ytd-comments, #comments, ytd-live-chat-renderer, #chat";

const GRID_LINK_IN_CARD_SEL = 'a[href*="watch?v="], a[href*="/shorts/"]';
const THUMB_IMG_SEL = 'img[src*="ytimg.com"]';

let gridSubtreeObservers = [];
let gridAppStructureObserver = null;
let gridResyncTimer = null;
let gridDebounceTimer = null;
let gridApplyGen = 0;
let playerApplyGen = 0;
let navApplyTimer = 0;
/** @type {{ root: Element; filterPrimaryInner: boolean }[] | null} */
let lastGridLayoutRoots = null;
/** Skip cache: card element -> last reconciled { id, t, th } so stable cards are skipped. */
const gridCardCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;
let learnedSincePruneCheck = 0;
/** Resolves once legacy keys are migrated; apply passes await it. */
let migrationReady = Promise.resolve();

/* ------------------------------------------------------------------ *
 * Pure helpers (no DOM / no storage) — also exported for unit tests.
 * ------------------------------------------------------------------ */

function normalizeTitle(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeTimestampOrDuration(s) {
  const t = normalizeTitle(s);
  if (!t) return true;
  if (/^\d{1,3}:\d{2}:\d{2}$/.test(t)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;
  return false;
}

/** A title worth pinning/learning: non-empty, not "undefined", not a bare timestamp. */
function isValidTitle(s) {
  if (s === undefined || s === null) return false;
  const t = normalizeTitle(String(s));
  if (!t || t === "undefined") return false;
  if (looksLikeTimestampOrDuration(t)) return false;
  return true;
}

/** A thumbnail worth pinning/learning: a YouTube image URL. */
function isValidThumb(s) {
  return typeof s === "string" && s.includes("ytimg.com");
}

function pinKey(id) {
  return `${PIN_PREFIX}${id}`;
}

/** Merge a learned patch ({ t?, th? }) into a prior record, refreshing the LRU timestamp. */
function mergeRecord(prev, patch) {
  const next = {
    t: prev && typeof prev.t === "string" ? prev.t : null,
    th: prev && typeof prev.th === "string" ? prev.th : null,
    ts: Date.now(),
  };
  if (patch && typeof patch.t === "string" && patch.t) next.t = patch.t;
  if (patch && typeof patch.th === "string" && patch.th) next.th = patch.th;
  return next;
}

/** Oldest ytPin keys to evict so the count returns to `max` (empty if under cap). */
function selectKeysToEvict(allObj, max) {
  const entries = [];
  for (const k in allObj) {
    if (!k.startsWith(PIN_PREFIX)) continue;
    const v = allObj[k];
    const ts = v && typeof v === "object" && typeof v.ts === "number" ? v.ts : 0;
    entries.push([k, ts]);
  }
  if (entries.length <= max) return [];
  entries.sort((a, b) => a[1] - b[1]); // oldest first
  return entries.slice(0, entries.length - max).map((e) => e[0]);
}

function extractVideoId(href) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtu.be") {
      const m = u.pathname.slice(1).match(YT_ID_RE);
      return m ? m[0] : null;
    }
    if (!host.endsWith("youtube.com")) return null;
    if (u.pathname.startsWith("/shorts/")) {
      const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }
    if (
      u.pathname === "/watch" ||
      u.pathname.startsWith("/watch/") ||
      u.pathname === "/" ||
      u.pathname === ""
    ) {
      const v = u.searchParams.get("v");
      if (v && YT_ID_RE.test(v)) return v.match(YT_ID_RE)[0];
    }
    if (u.pathname.startsWith("/embed/")) {
      const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }
    const v2 = u.searchParams.get("v");
    if (v2 && YT_ID_RE.test(v2)) return v2.match(YT_ID_RE)[0];
  } catch {
    return null;
  }
  return null;
}

function extractVideoIdFromYtNavigateDetail(detail) {
  if (!detail || typeof detail !== "object") return null;
  const pick = (x) => {
    if (!x || typeof x !== "string") return null;
    const m = x.match(YT_ID_RE);
    return m ? m[0] : null;
  };
  const candidates = [
    detail.endpoint?.watchEndpoint?.videoId,
    detail.endpoint?.reelWatchEndpoint?.videoId,
    detail.watchEndpoint?.videoId,
    detail.reelWatchEndpoint?.videoId,
    detail.response?.currentVideoEndpoint?.watchEndpoint?.videoId,
    detail.response?.metadata?.videoDetails?.videoId,
  ];
  for (const c of candidates) {
    const id = pick(c);
    if (id) return id;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Storage layer (single unified record per video).
 * ------------------------------------------------------------------ */

/** @returns {Promise<Map<string, {t:string|null, th:string|null, ts:number}>>} */
async function getPins(ids) {
  const map = new Map();
  if (!ids || ids.length === 0) return map;
  const keys = ids.map(pinKey);
  let data;
  try {
    data = await browser.storage.local.get(keys);
  } catch {
    return map;
  }
  for (const id of ids) {
    const rec = data[pinKey(id)];
    if (rec && typeof rec === "object") map.set(id, rec);
  }
  return map;
}

/**
 * Write learned patches. `patches` is Map<id, {t?, th?}>, `records` is the Map<id, record>
 * already read this pass (so we merge instead of clobbering the other field).
 */
async function commitPins(patches, records) {
  if (!patches || patches.size === 0) return;
  const writes = {};
  for (const [id, patch] of patches) {
    writes[pinKey(id)] = mergeRecord(records.get(id) || null, patch);
  }
  try {
    await browser.storage.local.set(writes);
  } catch {
    return;
  }
  void notePrune(patches.size);
}

async function notePrune(n) {
  learnedSincePruneCheck += n;
  if (learnedSincePruneCheck < PRUNE_CHECK_EVERY) return;
  learnedSincePruneCheck = 0;
  try {
    const all = await browser.storage.local.get(null);
    const toRemove = selectKeysToEvict(all, PIN_MAX);
    if (toRemove.length) await browser.storage.local.remove(toRemove);
  } catch {
    /* ignore */
  }
}

/** One-time fold of legacy ytTitleLock:/ytThumbLock: keys into ytPin: records. */
async function migrateLegacyIfNeeded() {
  try {
    const flag = await browser.storage.local.get(SCHEMA_KEY);
    if (flag[SCHEMA_KEY] >= SCHEMA_VERSION) return;

    const all = await browser.storage.local.get(null);
    const writes = {};
    const removes = [];
    const now = Date.now();
    const ensure = (id) =>
      (writes[pinKey(id)] ||= { t: null, th: null, ts: now });

    for (const k in all) {
      if (k.startsWith(LEGACY_TITLE_PREFIX)) {
        const id = k.slice(LEGACY_TITLE_PREFIX.length);
        if (isValidTitle(all[k])) ensure(id).t = normalizeTitle(String(all[k]));
        else ensure(id);
        removes.push(k);
      } else if (k.startsWith(LEGACY_THUMB_PREFIX)) {
        const id = k.slice(LEGACY_THUMB_PREFIX.length);
        if (isValidThumb(all[k])) ensure(id).th = all[k];
        else ensure(id);
        removes.push(k);
      }
    }

    if (Object.keys(writes).length) {
      // Don't clobber a ytPin record that already exists for the same id.
      for (const key in writes) {
        const ex = all[key];
        if (ex && typeof ex === "object") {
          if (!writes[key].t && typeof ex.t === "string") writes[key].t = ex.t;
          if (!writes[key].th && typeof ex.th === "string") writes[key].th = ex.th;
        }
      }
      await browser.storage.local.set(writes);
    }
    if (removes.length) await browser.storage.local.remove(removes);
    await browser.storage.local.set({ [SCHEMA_KEY]: SCHEMA_VERSION });
  } catch {
    /* ignore; retried on next load */
  }
}

/* ------------------------------------------------------------------ *
 * DOM read/write primitives.
 * ------------------------------------------------------------------ */

function cssEsc(id) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Prefer updating yt-formatted-string so the host heading keeps one component child. */
function getPinTextTarget(el) {
  if (!el) return null;
  if (el.nodeName === "YT-FORMATTED-STRING") return el;
  const direct = el.querySelector(":scope > yt-formatted-string");
  if (direct) return direct;
  const inner = el.querySelector("yt-formatted-string");
  return inner || el;
}

const PIN_TEXT_SKIP_SEL = "script, style, textarea, noscript";

/** Meaningful text nodes under a root (light DOM + open shadow roots), document order. */
function collectMeaningfulTextNodes(root, maxNodes) {
  const out = [];
  function walk(node) {
    if (out.length >= maxNodes) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (normalizeTitle(node.nodeValue)) out.push(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {Element} */ (node);
    if (typeof el.matches === "function" && el.matches(PIN_TEXT_SKIP_SEL)) return;
    for (const c of el.childNodes) {
      walk(c);
      if (out.length >= maxNodes) return;
    }
    const sr = el.shadowRoot;
    if (sr) {
      for (const c of sr.childNodes) {
        walk(c);
        if (out.length >= maxNodes) return;
      }
    }
  }
  walk(root);
  return out;
}

function currentTitleText(el) {
  const target = getPinTextTarget(el);
  return target ? normalizeTitle(target.textContent) : "";
}

function setPinnedTitleText(host, pin) {
  const target = getPinTextTarget(host);
  if (!target) return;
  const lock = normalizeTitle(pin);
  if (normalizeTitle(target.textContent) === lock) return;

  const nodes = collectMeaningfulTextNodes(target, 48);
  if (nodes.length > 0) {
    nodes[0].nodeValue = lock;
    for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = "";
    return;
  }
  if (target.childNodes.length === 0) {
    target.appendChild(target.ownerDocument.createTextNode(lock));
    return;
  }
  target.textContent = lock;
}

function extractThumbnailUrl(element) {
  if (!element) return null;
  const img = element.querySelector(THUMB_IMG_SEL);
  if (img) return img.src;
  const style = element.style?.backgroundImage;
  if (style && style.includes("ytimg.com")) {
    const m = style.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : null;
  }
  return null;
}

function setPinnedThumbnail(element, url) {
  if (!element || !url) return;
  const img = element.querySelector(THUMB_IMG_SEL) || element.querySelector("img");
  if (img) {
    if (img.src !== url) img.src = url;
    return;
  }
  if (element.style?.backgroundImage) {
    element.style.backgroundImage = `url('${url}')`;
  }
}

/* ------------------------------------------------------------------ *
 * Reconciliation engine — the one place that pins or learns a target.
 * ------------------------------------------------------------------ */

/**
 * Apply pinned values to a target, or return a learn-patch of native values.
 * @param {{ videoId:string, titleEl:Element|null, thumbEl:Element|null }} target
 * @param {{t:string|null, th:string|null}|null} record  stored pin for target.videoId
 * @param {{ expectTitle?: string|null }} [opts]  when set, only learn a title that equals it
 * @returns {{t?:string, th?:string}|null} patch to persist, or null
 */
function reconcileTarget(target, record, opts = {}) {
  const patch = {};

  if (target.titleEl) {
    const pinned = record && isValidTitle(record.t) ? normalizeTitle(record.t) : null;
    if (pinned !== null) {
      if (currentTitleText(target.titleEl) !== pinned) {
        setPinnedTitleText(target.titleEl, pinned);
      }
    } else {
      const native = currentTitleText(target.titleEl);
      if (isValidTitle(native) && (!opts.expectTitle || native === opts.expectTitle)) {
        patch.t = native;
      }
    }
  }

  if (target.thumbEl) {
    const pinned = record && isValidThumb(record.th) ? record.th : null;
    if (pinned !== null) {
      if (extractThumbnailUrl(target.thumbEl) !== pinned) {
        setPinnedThumbnail(target.thumbEl, pinned);
      }
    } else {
      const native = extractThumbnailUrl(target.thumbEl);
      if (isValidThumb(native)) patch.th = native;
    }
  }

  return "t" in patch || "th" in patch ? patch : null;
}

/* ------------------------------------------------------------------ *
 * Watch / Shorts.
 * ------------------------------------------------------------------ */

/** Prefer YouTube's navigate payload; else URL (watch ?v= or Shorts path). */
function currentPlayerVideoId(navDetail) {
  const fromNav = extractVideoIdFromYtNavigateDetail(navDetail);
  if (fromNav) return fromNav;
  if (location.pathname.startsWith("/shorts/")) {
    const m = location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  return extractVideoId(location.href);
}

/** The current video's title per document.title (used to confirm the watch DOM has settled). */
function expectedTitleFromDocument() {
  if (typeof document === "undefined" || !document.title) return "";
  let t = document.title.replace(/^\(\d+\)\s*/, ""); // unread-count prefix
  t = t.replace(/\s*-\s*YouTube\s*$/, ""); // trailing brand
  return normalizeTitle(t);
}

function findWatchTitleElement(videoId) {
  if (!videoId) return null;
  const scope =
    document.querySelector("#primary-inner") || document.querySelector("#primary");
  if (!scope) return null;
  const metas = scope.querySelectorAll(
    `ytd-watch-metadata[video-id="${cssEsc(videoId)}"]`
  );
  const meta = metas.length ? metas[metas.length - 1] : null;
  if (!meta) return null;
  for (const sel of ["h1.ytd-watch-metadata", "#title h1", "h1"]) {
    const el = meta.querySelector(sel);
    if (!el) continue;
    const t = currentTitleText(el);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  return null;
}

function findShortsTitleElement() {
  const scope =
    document.querySelector("ytd-shorts") ||
    document.querySelector("#shorts-container") ||
    document.body;
  for (const sel of ["h1.ytd-watch-metadata", "h2.ytd-shorts-title", "#title h1"]) {
    const el = scope.querySelector(sel);
    if (!el) continue;
    const t = currentTitleText(el);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  return null;
}

async function applyPlayer(navDetail) {
  await migrationReady;
  const myGen = ++playerApplyGen;

  const videoId = currentPlayerVideoId(navDetail);
  if (!videoId) return;
  const onShorts = location.pathname.startsWith("/shorts/");

  const pins = await getPins([videoId]);
  if (myGen !== playerApplyGen) return;
  const record = pins.get(videoId) || null;
  const hasPin = record && isValidTitle(record.t);

  const pickEl = () => (onShorts ? findShortsTitleElement() : findWatchTitleElement(videoId));

  let cumulative = 0;
  for (let i = 0; i < PLAYER_RETRY_MS.length; i++) {
    const wait = PLAYER_RETRY_MS[i] - cumulative;
    cumulative = PLAYER_RETRY_MS[i];
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    if (myGen !== playerApplyGen) return; // newer apply started
    if (currentPlayerVideoId() !== videoId) return; // navigated away

    const titleEl = pickEl();
    if (!titleEl) continue;

    if (hasPin) {
      reconcileTarget({ videoId, titleEl, thumbEl: null }, record);
      return;
    }

    // Learning: only save once the native title has settled (matches document.title),
    // relaxing the check on the final attempt so a quirky title still gets pinned.
    const lastTry = i === PLAYER_RETRY_MS.length - 1;
    const expectTitle = onShorts || lastTry ? null : expectedTitleFromDocument();
    const patch = reconcileTarget({ videoId, titleEl, thumbEl: null }, record, { expectTitle });
    if (patch && patch.t) {
      await commitPins(new Map([[videoId, patch]]), new Map([[videoId, record]]));
      return;
    }
    // not settled yet — let the loop retry, or wait for the next page event
  }
}

function scheduleApplyPlayer(navDetail) {
  if (navApplyTimer) clearTimeout(navApplyTimer);
  const d = navDetail;
  navApplyTimer = setTimeout(() => {
    navApplyTimer = 0;
    void applyPlayer(d);
  }, NAV_APPLY_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ *
 * Grid / list cards.
 * ------------------------------------------------------------------ */

function closestGridCard(el) {
  let n = el;
  while (n && n !== document.body) {
    if (GRID_CARD_TAGS.has(n.nodeName)) return n;
    n = n.parentElement;
  }
  return null;
}

function getGridTitleElement(card, link) {
  const byId = card.querySelector("#video-title");
  if (byId) return byId;
  const inner = link.querySelector("yt-formatted-string");
  if (inner) return inner;
  if (link.querySelector("ytd-thumbnail, img")) return null;
  return link;
}

/** The video id a card currently points at (for recycling re-verification). */
function cardVideoId(card) {
  const a = card.querySelector(GRID_LINK_IN_CARD_SEL);
  if (!a) return null;
  const href = a.getAttribute("href");
  if (!href) return null;
  try {
    return extractVideoId(new URL(href, location.origin).href);
  } catch {
    return null;
  }
}

function anchorLooksLikeGridLink(el) {
  if (!el || el.nodeName !== "A") return false;
  const href = el.getAttribute("href");
  if (!href) return false;
  return href.includes("watch?v=") || href.includes("/shorts/");
}

function appendPrimaryInnerRoot(out) {
  const primaryInner = document.querySelector("#primary-inner");
  if (primaryInner && primaryInner.isConnected) {
    out.push({ root: primaryInner, filterPrimaryInner: true });
  }
}

/** Roots watched by MutationObservers (no #secondary). */
function getGridObserverRoots() {
  const out = [];
  for (const sel of GRID_OBSERVER_ROOT_SELECTORS) {
    document.querySelectorAll(sel).forEach((root) => {
      if (root.isConnected) out.push({ root, filterPrimaryInner: false });
    });
  }
  appendPrimaryInnerRoot(out);
  return out;
}

/** Roots walked for anchor collection (includes #secondary). */
function getGridScanRoots() {
  const out = [];
  for (const sel of GRID_SCAN_ROOT_SELECTORS) {
    document.querySelectorAll(sel).forEach((root) => {
      if (root.isConnected) out.push({ root, filterPrimaryInner: false });
    });
  }
  appendPrimaryInnerRoot(out);
  return out;
}

function gridLayoutRootsMatch(prev, next) {
  if (!prev || !next || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].filterPrimaryInner !== next[i].filterPrimaryInner) return false;
    if (prev[i].root !== next[i].root) return false;
    if (!prev[i].root.isConnected) return false;
  }
  return true;
}

const PLAYER_SUBTREE_SEL =
  "ytd-player, #movie_player, video.html5-main-video, .html5-video-container";

/** First GRID_SCAN_CAP watch/shorts anchors under scan roots, stopping early. */
function collectFirstGridAnchors(maxCount) {
  const out = [];
  outer: for (const { root, filterPrimaryInner } of getGridScanRoots()) {
    if (!root.isConnected) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        if (node.matches(PLAYER_SUBTREE_SEL)) return NodeFilter.FILTER_REJECT;
        if (filterPrimaryInner && node.matches(PRIMARY_INNER_IGNORE_SEL)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      if (anchorLooksLikeGridLink(n)) {
        out.push(n);
        if (out.length >= maxCount) break outer;
      }
      n = walker.nextNode();
    }
  }
  return out;
}

function gridMutationsTouchListUi(mutations) {
  for (const m of mutations) {
    let t = m.target;
    if (t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    if (!t || typeof t.closest !== "function") continue;
    if (t.closest(PLAYER_SUBTREE_SEL)) continue;
    if (t.closest(PRIMARY_INNER_IGNORE_SEL)) continue;
    return true;
  }
  return false;
}

function scheduleApplyGridLocks() {
  if (gridDebounceTimer) clearTimeout(gridDebounceTimer);
  gridDebounceTimer = setTimeout(() => {
    gridDebounceTimer = null;
    void applyGridLocks();
  }, GRID_DEBOUNCE_MS);
}

/** True when a card already matches its cached reconciled state (so it can be skipped). */
function cardIsStable(card, id, titleEl, thumbEl) {
  if (!gridCardCache) return false;
  const cached = gridCardCache.get(card);
  if (!cached || cached.id !== id) return false;
  if (cached.t && currentTitleText(titleEl) !== cached.t) return false;
  if (cached.th && thumbEl && extractThumbnailUrl(thumbEl) !== cached.th) return false;
  return true;
}

async function applyGridLocks() {
  await migrationReady;
  const myGen = ++gridApplyGen;
  if (!document.querySelector("ytd-app")) return;

  const anchors = collectFirstGridAnchors(GRID_SCAN_CAP);
  const seen = new Set();
  /** @type {{card:Element, id:string, titleEl:Element, thumbEl:Element|null}[]} */
  const targets = [];
  for (const a of anchors) {
    if (a.closest("ytd-watch-metadata")) continue;
    const href = a.getAttribute("href");
    if (!href) continue;
    let id;
    try {
      id = extractVideoId(new URL(href, location.origin).href);
    } catch {
      continue;
    }
    if (!id) continue;
    const card = closestGridCard(a);
    if (!card || seen.has(card)) continue;
    seen.add(card);
    const titleEl = getGridTitleElement(card, a);
    if (!titleEl || !getPinTextTarget(titleEl).textContent) continue;
    const thumbEl = card.querySelector("ytd-thumbnail") || null;
    targets.push({ card, id, titleEl, thumbEl });
  }
  if (targets.length === 0) return;

  // Skip cards already reconciled and unchanged (no storage round-trip for them).
  const need = targets.filter((t) => !cardIsStable(t.card, t.id, t.titleEl, t.thumbEl));
  if (need.length === 0) return;

  const ids = [...new Set(need.map((t) => t.id))];
  const records = await getPins(ids);
  if (myGen !== gridApplyGen) return;

  const patches = new Map();
  for (const tgt of need) {
    // Recycling guard: the card may have been reused for another video during the await.
    if (cardVideoId(tgt.card) !== tgt.id) continue;

    const rec = records.get(tgt.id) || null;
    const patch = reconcileTarget(
      { videoId: tgt.id, titleEl: tgt.titleEl, thumbEl: tgt.thumbEl },
      rec
    );
    if (patch) {
      const prev = patches.get(tgt.id);
      patches.set(tgt.id, prev ? { ...prev, ...patch } : patch);
    }

    if (gridCardCache) {
      const pinnedT = rec && isValidTitle(rec.t) ? normalizeTitle(rec.t) : patch?.t || null;
      const pinnedTh = rec && isValidThumb(rec.th) ? rec.th : patch?.th || null;
      gridCardCache.set(tgt.card, { id: tgt.id, t: pinnedT, th: pinnedTh });
    }
  }

  await commitPins(patches, records);
}

/* ------------------------------------------------------------------ *
 * Observers + bootstrap.
 * ------------------------------------------------------------------ */

function disconnectGridSubtreeObservers() {
  for (const o of gridSubtreeObservers) {
    try {
      o.disconnect();
    } catch {
      /* ignore */
    }
  }
  gridSubtreeObservers = [];
}

function attachGridSubtreeObserver(root, filterPlayerSubtree) {
  const obs = new MutationObserver((mutations) => {
    if (filterPlayerSubtree && !gridMutationsTouchListUi(mutations)) return;
    scheduleApplyGridLocks();
  });
  obs.observe(root, { childList: true, subtree: true });
  gridSubtreeObservers.push(obs);
}

function scheduleResyncGridObservers() {
  if (gridResyncTimer) clearTimeout(gridResyncTimer);
  gridResyncTimer = setTimeout(() => {
    gridResyncTimer = null;
    syncGridObservers();
  }, GRID_RESYNC_DEBOUNCE_MS);
}

function syncGridObservers() {
  const app = document.querySelector("ytd-app");
  if (!app) return;

  const layoutRoots = getGridObserverRoots();
  if (gridLayoutRootsMatch(lastGridLayoutRoots, layoutRoots)) {
    if (!gridAppStructureObserver) {
      gridAppStructureObserver = new MutationObserver(() => scheduleResyncGridObservers());
      gridAppStructureObserver.observe(app, { childList: true, subtree: false });
    }
    return;
  }

  lastGridLayoutRoots = layoutRoots;
  disconnectGridSubtreeObservers();
  for (const { root, filterPrimaryInner } of layoutRoots) {
    attachGridSubtreeObserver(root, filterPrimaryInner);
  }
  if (!gridAppStructureObserver) {
    gridAppStructureObserver = new MutationObserver(() => scheduleResyncGridObservers());
    gridAppStructureObserver.observe(app, { childList: true, subtree: false });
  }
}

function onPageEvent(navDetail) {
  scheduleApplyPlayer(navDetail);
  scheduleApplyGridLocks();
  syncGridObservers();
}

// Only wire up live behaviour inside the extension (guarded so the file can be unit-tested).
if (typeof document !== "undefined" && typeof browser !== "undefined") {
  migrationReady = migrateLegacyIfNeeded();

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ytTitleLockHistoryState") onPageEvent(null);
  });

  // yt-page-data-updated is YouTube's "page data settled" signal; yt-navigate-finish fires
  // on SPA navigation. Both are events (not continuous observers on the title).
  for (const evt of ["yt-navigate-finish", "yt-page-data-updated"]) {
    document.addEventListener(evt, (ev) => onPageEvent(ev.detail), true);
  }

  window.addEventListener("popstate", () => onPageEvent(null));

  syncGridObservers();
  requestAnimationFrame(() => requestAnimationFrame(() => onPageEvent(null)));
}

// Export pure helpers for unit tests (no-op in the browser).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalizeTitle,
    looksLikeTimestampOrDuration,
    isValidTitle,
    isValidThumb,
    extractVideoId,
    extractVideoIdFromYtNavigateDetail,
    mergeRecord,
    selectKeysToEvict,
    expectedTitleFromDocument,
    PIN_PREFIX,
    PIN_MAX,
  };
}
