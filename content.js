/**
 * Pins the first-seen title and thumbnail per YouTube video to prevent
 * A/B-test flicker.
 *
 * Strategy: intercept YouTube's InnerTube API responses (fetch) and the
 * initial page data (ytInitialData / ytInitialPlayerResponse) to capture
 * (videoId, title, thumbnailUrl) tuples before YouTube renders them.
 *
 * An in-memory pin cache (loaded from storage on startup) lets us apply
 * pinned values synchronously inside the fetch interception — modifying
 * the JSON object before YouTube's code ever reads it.  We return a new
 * Response with the modified body so YouTube renders the pinned version
 * directly.  No DOM observers, no recycling races, no tentative gates.
 *
 * XHR interception is learn-only (we cannot reliably replace XHR response
 * bodies); a lightweight DOM fallback handles those rare cases.
 *
 * Storage: one record per video, `ytPin:<id> = { t, th, ts }`.
 * LRU-pruned to PIN_MAX.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const PIN_PREFIX = "ytPin:";
const ENABLED_KEY = "ytPinEnabled";
const SCHEMA_KEY = "ytPinSchema";
const SCHEMA_VERSION = 2;
const LEGACY_TITLE_PREFIX = "ytTitleLock:";
const LEGACY_THUMB_PREFIX = "ytThumbLock:";

const PIN_MAX = 5000;
const PRUNE_CHECK_EVERY = 200;

const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;
const YT_API_RE = /\/youtubei\/v1\/([^?]+)/;

/** DOM fallback debounce (apply-only, no learning). */
const DOM_FALLBACK_DEBOUNCE_MS = 300;
/** Minimum ms between storage commits after learning new entries. */
const COMMIT_DEBOUNCE_MS = 500;
/** Max entries to scan per DOM pass. */
const DOM_SCAN_CAP = 400;

/** Legacy constant — kept for unit-test compatibility with the old 2-pass gate. */
const TENTATIVE_SETTLE_MS = 750;

// --- state ---

/**
 * In-memory pin cache: Map<videoId, {t, th, ts}>.
 * Loaded from storage on startup, kept in sync via storage.onChanged.
 * This lets us apply pins SYNCHRONOUSLY inside fetch/initial-data traps.
 */
const pinCache = new Map();
/** Resolves when the cache has been fully loaded from storage. */
let pinCacheResolve;
const pinCacheReady = new Promise((r) => { pinCacheResolve = r; });
let cacheLoaded = false;

/** Entries learned this session that haven't been flushed to storage yet. */
const pendingWrites = new Map();
let commitTimer = null;
let learnedSincePruneCheck = 0;

let domFallbackTimer = null;
let migrationReady = Promise.resolve();

/** Master on/off switch, controlled from the toolbar popup. Default on. */
let enabled = true;

/* ------------------------------------------------------------------ *
 * Pure helpers (no DOM / no storage).
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

function isValidTitle(s) {
  if (s === undefined || s === null) return false;
  const t = normalizeTitle(String(s));
  if (!t || t === "undefined") return false;
  if (looksLikeTimestampOrDuration(t)) return false;
  return true;
}

function isValidThumb(s) {
  return typeof s === "string" && s.includes("ytimg.com");
}

function pinKey(id) {
  return `${PIN_PREFIX}${id}`;
}

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

function selectKeysToEvict(allObj, max) {
  const entries = [];
  for (const k in allObj) {
    if (!k.startsWith(PIN_PREFIX)) continue;
    const v = allObj[k];
    const ts = v && typeof v === "object" && typeof v.ts === "number" ? v.ts : 0;
    entries.push([k, ts]);
  }
  if (entries.length <= max) return [];
  entries.sort((a, b) => a[1] - b[1]);
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
 * Pin cache — in-memory, kept in sync with storage.
 * ------------------------------------------------------------------ */

/** Load the full cache from storage (called once on startup). */
async function loadPinCache() {
  try {
    const all = await browser.storage.local.get(null);
    enabled = all[ENABLED_KEY] !== false; // absent / true = enabled
    for (const k of Object.keys(all)) {
      if (!k.startsWith(PIN_PREFIX)) continue;
      const rec = all[k];
      if (rec && typeof rec === "object" && (rec.t || rec.th)) {
        pinCache.set(k.slice(PIN_PREFIX.length), rec);
      }
    }
  } catch {
    /* ignore */
  }
}

/** Persist pending writes to storage, debounced. */
function scheduleCommit() {
  if (commitTimer) return;
  commitTimer = setTimeout(() => {
    commitTimer = null;
    void flushCommit();
  }, COMMIT_DEBOUNCE_MS);
}

async function flushCommit() {
  const writes = {};
  for (const [id, patch] of pendingWrites) {
    const existing = pinCache.get(id);
    writes[pinKey(id)] = mergeRecord(existing || null, patch);
  }
  pendingWrites.clear();

  if (Object.keys(writes).length === 0) return;

  try {
    await browser.storage.local.set(writes);
  } catch {
    return;
  }

  learnedSincePruneCheck += Object.keys(writes).length;
  if (learnedSincePruneCheck >= PRUNE_CHECK_EVERY) {
    learnedSincePruneCheck = 0;
    try {
      const all = await browser.storage.local.get(null);
      const toRemove = selectKeysToEvict(all, PIN_MAX);
      if (toRemove.length) await browser.storage.local.remove(toRemove);
    } catch {
      /* ignore */
    }
  }
}

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
 * JSON walking: extract video entries & apply pins in place.
 * ------------------------------------------------------------------ */

function readTitleFromObj(obj) {
  if (!obj || typeof obj !== "object") return null;

  if (typeof obj.title === "string" && obj.title) return obj.title;
  if (obj.title?.runs?.[0]?.text) return obj.title.runs[0].text;
  if (obj.title?.simpleText) return obj.title.simpleText;
  if (obj.headline?.simpleText) return obj.headline.simpleText;
  if (obj.metadata?.lockupMetadataViewModel?.title?.content) {
    return obj.metadata.lockupMetadataViewModel.title.content;
  }
  if (obj.videoPrimaryInfoRenderer?.title?.runs?.[0]?.text) {
    return obj.videoPrimaryInfoRenderer.title.runs[0].text;
  }
  return null;
}

function writeTitleToObj(obj, text) {
  if (!obj || typeof obj !== "object" || !text) return false;

  if (typeof obj.title === "string") { obj.title = text; return true; }
  if (obj.title?.runs?.[0]) { obj.title.runs[0].text = text; return true; }
  if (obj.title?.simpleText !== undefined) { obj.title.simpleText = text; return true; }
  if (obj.headline?.simpleText !== undefined) { obj.headline.simpleText = text; return true; }
  if (obj.metadata?.lockupMetadataViewModel?.title) {
    obj.metadata.lockupMetadataViewModel.title.content = text;
    return true;
  }
  if (obj.videoPrimaryInfoRenderer?.title?.runs?.[0]) {
    obj.videoPrimaryInfoRenderer.title.runs[0].text = text;
    return true;
  }
  if (obj.videoDetails?.title) { obj.videoDetails.title = text; return true; }
  return false;
}

function readThumbFromObj(obj) {
  if (!obj || typeof obj !== "object") return null;

  const arr = obj.thumbnail?.thumbnails;
  if (Array.isArray(arr)) {
    for (const t of arr) {
      if (t?.url && t.url.includes("ytimg.com")) return t.url;
    }
  }

  const vdArr = obj.videoDetails?.thumbnail?.thumbnails;
  if (Array.isArray(vdArr)) {
    for (const t of vdArr) {
      if (t?.url && t.url.includes("ytimg.com")) return t.url;
    }
  }

  const sources = obj.contentImage?.thumbnailViewModel?.image?.sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (s?.url && s.url.includes("ytimg.com")) return s.url;
    }
  }

  return null;
}

function writeThumbToObj(obj, url) {
  if (!obj || typeof obj !== "object" || !url) return false;

  const arr = obj.thumbnail?.thumbnails;
  if (Array.isArray(arr)) { for (const t of arr) t.url = url; return true; }

  const vdArr = obj.videoDetails?.thumbnail?.thumbnails;
  if (Array.isArray(vdArr)) { for (const t of vdArr) t.url = url; return true; }

  const sources = obj.contentImage?.thumbnailViewModel?.image?.sources;
  if (Array.isArray(sources)) { for (const s of sources) s.url = url; return true; }

  return false;
}

function readVideoId(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.videoId === "string" && YT_ID_RE.test(obj.videoId)) return obj.videoId;
  if (obj.videoDetails?.videoId && YT_ID_RE.test(obj.videoDetails.videoId)) return obj.videoDetails.videoId;
  if (typeof obj.contentId === "string" && YT_ID_RE.test(obj.contentId)) return obj.contentId;
  return null;
}

const UNWRAP_KEYS = new Set([
  "videoRenderer", "compactVideoRenderer", "gridVideoRenderer",
  "richItemRenderer", "reelItemRenderer", "movieRenderer",
  "playlistVideoRenderer", "channelVideoRenderer",
  "playlistPanelVideoRenderer", "lockupViewModel", "shortsLockupViewModel",
  "content",
]);

/**
 * Walk a JSON object recursively and collect every renderer-like node.
 * Returns { videoId, title, thumbUrl, _obj } for each video found.
 * The _obj reference lets us modify the original JSON in place.
 */
function collectVideoEntries(root, maxEntries) {
  const out = [];
  const max = maxEntries || 5000;
  const visited = new WeakSet();

  function walk(val) {
    if (out.length >= max) return;
    if (!val || typeof val !== "object") return;
    if (visited.has(val)) return;
    visited.add(val);

    const vid = readVideoId(val);
    if (vid) {
      const title = readTitleFromObj(val);
      const thumbUrl = readThumbFromObj(val);
      if (title || thumbUrl) {
        out.push({ videoId: vid, title, thumbUrl, _obj: val });
      }
    }

    // Unwrap renderer wrappers to find the inner data
    for (const k of UNWRAP_KEYS) {
      const inner = val[k];
      if (inner && typeof inner === "object") walk(inner);
    }

    // Walk array / object children (skip already-unwrapped keys)
    if (Array.isArray(val)) {
      for (const item of val) walk(item);
    } else {
      for (const key of Object.keys(val)) {
        if (UNWRAP_KEYS.has(key)) continue;
        const child = val[key];
        if (child && typeof child === "object") walk(child);
      }
    }
  }

  walk(root);
  return out;
}

/* ------------------------------------------------------------------ *
 * Core: process extracted entries — learn + apply pins synchronously.
 * ------------------------------------------------------------------ */

/**
 * Process video entries extracted from a JSON response:
 * 1. Apply existing pins from the in-memory cache (sync).
 * 2. Learn new entries for videos not yet in cache (cache update sync;
 *    storage write async).
 *
 * Returns true if any pin was applied (meaning the JSON was modified).
 */
function processEntries(entries) {
  if (!enabled) return false;

  let modified = false;
  const newlySeen = [];

  for (const e of entries) {
    const rec = pinCache.get(e.videoId);

    if (rec) {
      // Pin exists — apply it to the JSON object
      if (isValidTitle(rec.t) && writeTitleToObj(e._obj, normalizeTitle(rec.t))) {
        modified = true;
      }
      if (isValidThumb(rec.th) && writeThumbToObj(e._obj, rec.th)) {
        modified = true;
      }
    } else {
      // No pin yet — learn first-seen
      const patch = {};
      if (isValidTitle(e.title)) patch.t = normalizeTitle(e.title);
      if (isValidThumb(e.thumbUrl)) patch.th = e.thumbUrl;
      if (patch.t || patch.th) {
        newlySeen.push({ id: e.videoId, patch });
      }
    }
  }

  // Update in-memory cache immediately (sync, so future fetch responses
  // see the pin).  Storage write is deferred.
  for (const { id, patch } of newlySeen) {
    const existing = pinCache.get(id);
    pinCache.set(id, mergeRecord(existing || null, patch));
    const prev = pendingWrites.get(id);
    pendingWrites.set(id, prev ? { ...prev, ...patch } : patch);
  }

  if (newlySeen.length > 0) scheduleCommit();

  return modified;
}

/* ------------------------------------------------------------------ *
 * API interception — fetch.
 * ------------------------------------------------------------------ */

function isYtApiUrl(str) {
  return typeof str === "string" && YT_API_RE.test(str);
}

function getYtEndpoint(str) {
  const m = str.match(YT_API_RE);
  return m ? m[1] : "";
}

function patchFetch() {
  const _fetch = window.fetch;

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";

    const response = await _fetch.call(this, input, init);

    if (!isYtApiUrl(url)) return response;

    const ep = getYtEndpoint(url);
    if (!/^(player|next|browse|search|reel)/.test(ep)) return response;

    try {
      const clone = response.clone();
      const json = await clone.json();
      const entries = collectVideoEntries(json, 4000);

      if (entries.length === 0) return response;

      // Guard against race: if the cache hasn't loaded yet, wait before
      // processing — otherwise we could overwrite an existing stored pin
      // with this response's first-seen value.
      await pinCacheReady;

      const modified = processEntries(entries);

      if (modified) {
        // Return a new Response with the pinned values baked in.
        // YouTube's code reads this modified body instead of the original.
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    } catch {
      /* clone/parse failure is non-fatal */
    }

    return response;
  };
}

/* ------------------------------------------------------------------ *
 * API interception — XHR (learn-only; unreliable to modify responses).
 * ------------------------------------------------------------------ */

function patchXHR() {
  const XHRProto = XMLHttpRequest.prototype;
  const _open = XHRProto.open;
  const _send = XHRProto.send;

  XHRProto.open = function (method, url) {
    this.__ytUrl = typeof url === "string" ? url : url?.toString?.() || "";
    return _open.apply(this, arguments);
  };

  XHRProto.send = function () {
    const url = this.__ytUrl;
    if (isYtApiUrl(url)) {
      const ep = getYtEndpoint(url);
      if (/^(player|next|browse|search|reel)/.test(ep)) {
        this.addEventListener("readystatechange", function handler() {
          if (this.readyState === XMLHttpRequest.DONE && this.status === 200) {
            try {
              const json = JSON.parse(this.responseText);
              const entries = collectVideoEntries(json, 4000);
              if (entries.length > 0) {
                // We cannot await inside a synchronous event handler,
                // but pinCacheReady is almost certainly resolved by now
                // (the first XHR call fires long after JS initialization).
                // Queue the processing microtask-style.
                void pinCacheReady.then(() => {
                  processEntries(entries);
                  scheduleDomFallback();
                });
              }
            } catch {
              /* ignore */
            }
          }
        });
      }
    }
    return _send.apply(this, arguments);
  };
}

/* ------------------------------------------------------------------ *
 * Initial data traps — intercept ytInitialData / ytInitialPlayerResponse
 * assignment on full-page loads before YouTube processes them.
 * ------------------------------------------------------------------ */

function trapWindowProperty(name) {
  let stored = undefined;
  Object.defineProperty(window, name, {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(v) {
      stored = v;
      if (v && typeof v === "object") {
        if (cacheLoaded) {
          const entries = collectVideoEntries(v, 4000);
          processEntries(entries);
        } else {
          // Cache not loaded yet — defer to avoid overwriting existing pins.
          // The DOM fallback will apply pins once the cache is ready.
          void pinCacheReady.then(() => {
            const entries = collectVideoEntries(v, 4000);
            processEntries(entries);
          });
        }
      }
    },
  });
}

function installInitialDataTraps() {
  if (!("ytInitialData" in window)) trapWindowProperty("ytInitialData");
  if (!("ytInitialPlayerResponse" in window)) trapWindowProperty("ytInitialPlayerResponse");
}

/* ------------------------------------------------------------------ *
 * DOM fallback (apply-only, never learns).
 *
 * Handles the rare case where XHR responses were not modified and
 * YouTube's DOM still shows the native title/thumbnail.
 * ─────────────────────────────────────────────────────────────────── */

const GRID_CARD_TAGS = new Set([
  "YTD-RICH-ITEM-RENDERER", "YTD-VIDEO-RENDERER",
  "YTD-GRID-VIDEO-RENDERER", "YTD-COMPACT-VIDEO-RENDERER",
  "YTD-RICH-GRID-MEDIA", "YTD-REEL-ITEM-RENDERER",
  "YTD-MOVIE-RENDERER", "YTD-PLAYLIST-VIDEO-RENDERER",
  "YTD-CHANNEL-VIDEO-RENDERER", "YTD-PLAYLIST-PANEL-VIDEO-RENDERER",
]);

const GRID_LINK_SEL = 'a[href*="watch?v="], a[href*="/shorts/"]';
const THUMB_IMG_SEL = 'img[src*="ytimg.com"]';

// --- DOM read/write ---

function cssEsc(id) {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(id)
    : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getPinTextTarget(el) {
  if (!el) return null;
  if (el.nodeName === "YT-FORMATTED-STRING") return el;
  const direct = el.querySelector(":scope > yt-formatted-string");
  if (direct) return direct;
  const inner = el.querySelector("yt-formatted-string");
  return inner || el;
}

const PIN_TEXT_SKIP_SEL = "script, style, textarea, noscript";

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

// --- DOM scan ---

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

/**
 * Apply-only DOM scan: for each visible video card, if we have a pin in
 * the in-memory cache, write it to the DOM.  Never learns.
 */
async function applyDomFallback() {
  await migrationReady;
  if (!enabled) return;

  const roots = [
    "#contents", "ytd-miniplayer", "ytd-shorts",
    "#secondary", "#primary-inner", "#primary",
  ];
  const seen = new Set();
  const targets = [];

  for (const sel of roots) {
    for (const root of document.querySelectorAll(sel)) {
      if (!root.isConnected) continue;
      const links = root.querySelectorAll(GRID_LINK_SEL);
      for (const a of links) {
        if (targets.length >= DOM_SCAN_CAP) break;
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
        if (!titleEl) continue;
        const thumbEl = card.querySelector("ytd-thumbnail") || null;
        targets.push({ card, id, titleEl, thumbEl });
      }
    }
  }

  for (const t of targets) {
    const rec = pinCache.get(t.id);
    if (!rec) continue;
    if (isValidTitle(rec.t) && currentTitleText(t.titleEl) !== normalizeTitle(rec.t)) {
      setPinnedTitleText(t.titleEl, rec.t);
    }
    if (t.thumbEl && isValidThumb(rec.th) && extractThumbnailUrl(t.thumbEl) !== rec.th) {
      setPinnedThumbnail(t.thumbEl, rec.th);
    }
  }
}

function scheduleDomFallback() {
  if (domFallbackTimer) clearTimeout(domFallbackTimer);
  domFallbackTimer = setTimeout(() => {
    domFallbackTimer = null;
    void applyDomFallback();
  }, DOM_FALLBACK_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ *
 * Watch / Shorts title fallback.
 *
 * On a watch page the main title is normally pinned via the player
 * response JSON (intercepted above).  This handles the rare case
 * where the DOM is already rendered before our trap fires.
 * ------------------------------------------------------------------ */

async function applyWatchTitle() {
  await migrationReady;
  if (!enabled) return;

  const onShorts = location.pathname.startsWith("/shorts/");
  let videoId;
  if (onShorts) {
    const m = location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    videoId = m ? m[1] : null;
  } else {
    videoId = extractVideoId(location.href);
  }
  if (!videoId) return;

  const rec = pinCache.get(videoId);
  if (!rec || !isValidTitle(rec.t)) return;

  const pinned = normalizeTitle(rec.t);

  if (onShorts) {
    const scope =
      document.querySelector("ytd-shorts") ||
      document.querySelector("#shorts-container") ||
      document.body;
    for (const sel of ["h1.ytd-watch-metadata", "h2.ytd-shorts-title", "#title h1"]) {
      const el = scope.querySelector(sel);
      if (el && currentTitleText(el) !== pinned) {
        setPinnedTitleText(el, pinned);
        break;
      }
    }
  } else {
    const scope =
      document.querySelector("#primary-inner") || document.querySelector("#primary");
    if (scope) {
      const metas = scope.querySelectorAll(
        `ytd-watch-metadata[video-id="${cssEsc(videoId)}"]`
      );
      const meta = metas.length ? metas[metas.length - 1] : null;
      if (meta) {
        for (const sel of ["h1.ytd-watch-metadata", "#title h1", "h1"]) {
          const el = meta.querySelector(sel);
          if (el && currentTitleText(el) !== pinned) {
            setPinnedTitleText(el, pinned);
            break;
          }
        }
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Bootstrap.
 * ------------------------------------------------------------------ */

if (typeof document !== "undefined" && typeof browser !== "undefined") {
  // Migration runs first (it may produce legacy records for the cache).
  migrationReady = migrateLegacyIfNeeded().then(async () => {
    await loadPinCache();
    cacheLoaded = true;
    pinCacheResolve();
  });

  // 1. Install initial-data traps before YouTube's JS boots.
  installInitialDataTraps();

  // 2. Monkey-patch network layer.
  patchFetch();
  patchXHR();

  // 3. Keep the cache in sync if another tab writes new pins.
  if (browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.prototype.hasOwnProperty.call(changes, ENABLED_KEY)) {
        enabled = changes[ENABLED_KEY].newValue !== false;
        // Re-pin the current page immediately when switched back on.
        // (Switching off stops future pinning; already-shown values
        //  revert on the next navigation / reload.)
        if (enabled) {
          scheduleDomFallback();
          applyWatchTitle();
        }
      }
      for (const k of Object.keys(changes)) {
        if (!k.startsWith(PIN_PREFIX)) continue;
        const id = k.slice(PIN_PREFIX.length);
        const { newValue } = changes[k];
        if (newValue && typeof newValue === "object" && (newValue.t || newValue.th)) {
          pinCache.set(id, newValue);
        } else {
          pinCache.delete(id);
        }
      }
    });
  }

  // 4. React to YouTube's own navigation events (complementary).
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ytTitleLockHistoryState") {
      scheduleDomFallback();
    }
  });

  for (const evt of ["yt-navigate-finish", "yt-page-data-updated"]) {
    document.addEventListener(
      evt,
      () => {
        scheduleDomFallback();
        applyWatchTitle();
      },
      true
    );
  }

  window.addEventListener("popstate", () => {
    scheduleDomFallback();
  });

  // 5. First paint — handle the case where ytInitialData was already set
  //    before our trap fired (e.g. Firefox script execution ordering).
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      await migrationReady;
      if (window.ytInitialData) {
        const entries = collectVideoEntries(window.ytInitialData, 4000);
        processEntries(entries);
      }
      if (window.ytInitialPlayerResponse) {
        const entries = collectVideoEntries(window.ytInitialPlayerResponse, 4000);
        processEntries(entries);
      }
      scheduleDomFallback();
      applyWatchTitle();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Unit-test exports.
 * ------------------------------------------------------------------ */
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
    PIN_PREFIX,
    PIN_MAX,
    TENTATIVE_SETTLE_MS,
  };
}
