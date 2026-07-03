/**
 * Pins the first-seen title and thumbnail per YouTube video to prevent
 * A/B-test flicker.
 *
 * Strategy: `content-main.js` runs in YouTube's MAIN world and intercepts
 * InnerTube responses / initial page data before YouTube renders them.
 * This isolated script owns extension storage, decides which values are
 * pinned, learns first-seen tuples, and applies a small DOM fallback only
 * where response-body replacement is not possible.
 *
 * `content-main.js` cannot access browser.storage from the MAIN world, so it
 * sends stripped video entries here through window.postMessage and receives
 * only the patches needed for the current response.
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
const PAGE_BRIDGE_SOURCE = "yt-pin-main";
const CONTENT_BRIDGE_SOURCE = "yt-pin-content";

/** DOM fallback debounce (apply-only, no learning). */
const DOM_FALLBACK_DEBOUNCE_MS = 450;
/** Minimum ms between storage commits after learning new entries. */
const COMMIT_DEBOUNCE_MS = 500;
/** Max entries to scan per DOM pass. */
const DOM_SCAN_CAP = 180;

/** Legacy constant — kept for unit-test compatibility with the old 2-pass gate. */
const TENTATIVE_SETTLE_MS = 750;

// --- state ---

/**
 * In-memory pin cache: Map<videoId, {t, th, ts}>.
 * Loaded from storage on startup, kept in sync via storage.onChanged.
 * This lets us apply pins SYNCHRONOUSLY inside fetch/initial-data traps.
 */
const pinCache = new Map();
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
 * MAIN-world bridge.
 * ------------------------------------------------------------------ */

function postBridgeMessage(type, payload, requestId) {
  window.postMessage(
    { source: CONTENT_BRIDGE_SOURCE, type, requestId, payload },
    "*"
  );
}

function sendBridgeReady() {
  postBridgeMessage("READY", { enabled });
}

function processBridgeEntries(entries, canModify) {
  if (!enabled) return { enabled: false, patches: [] };

  const patches = [];
  const newlySeen = [];
  let needsDomApply = false;

  for (const e of entries) {
    if (!e || !e.videoId) continue;
    const rec = pinCache.get(e.videoId);

    if (rec) {
      const patch = { i: e.i };
      if (isValidTitle(rec.t)) patch.t = normalizeTitle(rec.t);
      if (isValidThumb(rec.th)) patch.th = rec.th;
      if (patch.t || patch.th) {
        patches.push(patch);
        if (!canModify) needsDomApply = true;
      }

      const missing = {};
      if (!isValidTitle(rec.t) && isValidTitle(e.title)) {
        missing.t = normalizeTitle(e.title);
      }
      if (!isValidThumb(rec.th) && isValidThumb(e.thumbUrl)) {
        missing.th = e.thumbUrl;
      }
      if (missing.t || missing.th) newlySeen.push({ id: e.videoId, patch: missing });
      continue;
    }

    const firstSeen = {};
    if (isValidTitle(e.title)) firstSeen.t = normalizeTitle(e.title);
    if (isValidThumb(e.thumbUrl)) firstSeen.th = e.thumbUrl;
    if (firstSeen.t || firstSeen.th) newlySeen.push({ id: e.videoId, patch: firstSeen });
  }

  for (const { id, patch } of newlySeen) {
    const existing = pinCache.get(id);
    pinCache.set(id, mergeRecord(existing || null, patch));
    const prev = pendingWrites.get(id);
    pendingWrites.set(id, prev ? { ...prev, ...patch } : patch);
  }

  if (newlySeen.length > 0) scheduleCommit();
  if (needsDomApply) scheduleDomFallback();

  return { enabled: true, patches };
}

async function handleBridgeRequest(type, payload) {
  await migrationReady;
  if (type !== "PROCESS_ENTRIES") return { enabled, patches: [] };
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  return processBridgeEntries(entries, payload?.canModify !== false);
}

function installPageBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE_BRIDGE_SOURCE) return;

    if (msg.type === "READY") {
      void migrationReady.then(sendBridgeReady);
      return;
    }

    if (msg.type !== "PROCESS_ENTRIES") return;
    void handleBridgeRequest(msg.type, msg.payload).then((payload) => {
      postBridgeMessage("RESPONSE", payload, msg.requestId);
    });
  });
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
  installPageBridge();

  // Migration runs first (it may produce legacy records for the cache).
  migrationReady = migrateLegacyIfNeeded().then(async () => {
    await loadPinCache();
    sendBridgeReady();
  });

  // Keep the cache in sync if another tab writes new pins.
  if (browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (Object.prototype.hasOwnProperty.call(changes, ENABLED_KEY)) {
        enabled = changes[ENABLED_KEY].newValue !== false;
        sendBridgeReady();
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

  // React to YouTube's own navigation events (complementary).
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

  // First paint fallback. Network interception should handle most cards;
  // this catches XHR-only surfaces and already-rendered watch titles.
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      await migrationReady;
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
