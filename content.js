/**
 * Pins first-seen titles per YouTube video on the player (watch/shorts) and on grid cards
 * (home, search, related, etc.). Depends on lib/browser-polyfill.min.js.
 */

/** Watch player: never use bare yt-formatted-string.ytd-watch-metadata — first match is often duration. */
const WATCH_TITLE_SELECTORS = [
  "ytd-watch-metadata h1.ytd-watch-metadata",
  "ytd-watch-metadata #title h1",
  "h1.ytd-watch-metadata",
  "#title h1",
];

/** Shorts / odd layouts: try h1 first, then formatted strings with duration filter in findTitleElement. */
const SHORTS_TITLE_SELECTORS = [
  "h1.ytd-watch-metadata",
  "ytd-watch-metadata h1",
  "#title h1",
  "h2.ytd-shorts-title",
];

const PENDING_CLASS = "yt-title-lock-pending";
const STYLE_ID = "yt-title-lock-style";
const STORAGE_PREFIX = "ytTitleLock:";
const PARENT_WAIT_MS = 15000;

const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;

const GRID_LINK_SEL = 'a[href*="watch?v="], a[href*="/shorts/"]';
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

const GRID_SCAN_CAP = 500;
const GRID_DEBOUNCE_MS = 250;

/** @type {{ videoId: string, lock: string | null, observer: MutationObserver | null, rafId: number } | null} */
let session = null;
let sessionGeneration = 0;

let gridObserver = null;
let gridDebounceTimer = null;
let gridApplyGen = 0;

function storageKey(videoId) {
  return `${STORAGE_PREFIX}${videoId}`;
}

function normalizeTitle(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidLockValue(v) {
  if (v === undefined || v === null) return false;
  const s = typeof v === "string" ? v : String(v);
  const t = normalizeTitle(s);
  if (!t) return false;
  if (t === "undefined") return false;
  return true;
}

/** YouTube puts duration (e.g. 16:59) in metadata rows that share classes with title fragments — reject as title/lock. */
function looksLikeTimestampOrDuration(s) {
  const t = normalizeTitle(s);
  if (!t) return true;
  if (/^\d{1,3}:\d{2}:\d{2}$/.test(t)) return true;
  if (/^\d{1,2}:\d{2}$/.test(t)) return true;
  return false;
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
    if (u.pathname === "/watch" || u.pathname.startsWith("/watch/")) {
      const v = u.searchParams.get("v");
      if (v && YT_ID_RE.test(v)) return v.match(YT_ID_RE)[0];
    }
    if (u.pathname.startsWith("/shorts/")) {
      const m = u.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }
    if (u.pathname.startsWith("/embed/")) {
      const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      return m ? m[1] : null;
    }
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

/**
 * What is actually loaded in the watch column (player / metadata). Prefer this over
 * location.href — the URL can lag SPA swaps, so the extension would keep the first video's
 * lock and overwrite the h1 for every subsequent watch.
 */
function getLivePlayerVideoId() {
  const scope =
    document.querySelector("#primary-inner") ||
    document.querySelector("#primary") ||
    document.querySelector("ytd-watch-flexy");
  if (!scope) return null;

  const players = Array.from(
    scope.querySelectorAll("ytd-player#ytd-player, ytd-player")
  );
  for (let i = players.length - 1; i >= 0; i--) {
    const raw = players[i].getAttribute("video-id");
    const m = raw?.match(YT_ID_RE);
    if (m) return m[0];
  }

  const metas = Array.from(scope.querySelectorAll("ytd-watch-metadata[video-id]"));
  for (let i = metas.length - 1; i >= 0; i--) {
    const raw = metas[i].getAttribute("video-id");
    const m = raw?.match(YT_ID_RE);
    if (m) return m[0];
  }

  return null;
}

/** Single source of truth for "which video is this page showing?" */
function getLiveVideoId(navDetail) {
  const fromNav = extractVideoIdFromYtNavigateDetail(navDetail);
  const fromPlayer = getLivePlayerVideoId();
  const fromUrl = extractVideoId(location.href);

  if (location.pathname.startsWith("/shorts/")) {
    return fromNav || fromUrl || fromPlayer;
  }

  if (fromNav) return fromNav;

  // Watch: same-tab SPA updates the address bar; player / DOM often lag. Use ?v= first.
  if (fromUrl) return fromUrl;
  return fromPlayer;
}

function isElementVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden") return false;
  return el.offsetParent !== null || st.position === "fixed";
}

function metadataMatchesVideo(meta, videoId) {
  const vid = meta.getAttribute("video-id");
  if (vid === videoId) return true;
  for (const a of meta.querySelectorAll("a[href]")) {
    try {
      const id = extractVideoId(
        new URL(a.getAttribute("href") || "", location.origin).href
      );
      if (id === videoId) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * After SPA navigation YouTube can leave multiple ytd-watch-metadata nodes in #primary.
 * Always pick the block for this video, or the last visible one (newest mount).
 */
function findWatchMetadataForVideo(scope, videoId) {
  if (!scope || !videoId) return null;
  const all = Array.from(scope.querySelectorAll("ytd-watch-metadata"));
  if (all.length === 0) return null;

  const idMatch = all.filter((m) => m.getAttribute("video-id") === videoId);
  if (idMatch.length) {
    const visible = idMatch.filter(isElementVisible);
    const pool = visible.length ? visible : idMatch;
    return pool[pool.length - 1];
  }

  const matched = all.filter((m) => metadataMatchesVideo(m, videoId));
  const pool = matched.length ? matched : all;
  const visible = pool.filter(isElementVisible);
  const pickFrom = visible.length ? visible : pool;
  return pickFrom[pickFrom.length - 1];
}

function findStableParentForWatchMeta(meta, scope) {
  if (!meta) return null;
  const fold = meta.closest("#above-the-fold");
  if (fold && scope.contains(fold)) return fold;
  const flexy = meta.closest("ytd-watch-flexy");
  if (flexy && scope.contains(flexy)) return flexy;
  return meta;
}

function findShortsStableParent(scope, videoId) {
  if (!scope) return null;
  const byAttr = scope.querySelector(
    `ytd-reel-video-renderer[video-id="${videoId}"]`
  );
  if (byAttr) return byAttr;
  const reels = Array.from(scope.querySelectorAll("ytd-reel-video-renderer"));
  for (const r of reels) {
    if (metadataMatchesVideo(r, videoId)) return r;
  }
  const vis = reels.filter(isElementVisible);
  if (vis.length) return vis[vis.length - 1];
  return scope.querySelector("ytd-shorts") || scope;
}

/**
 * Scope player title queries to the active watch/shorts column so document.querySelector
 * does not hit a cached/hidden metadata node from a previous SPA navigation (bug: wrong title stuck).
 */
function getPlayerScopeRoot() {
  const path = location.pathname;
  if (path.startsWith("/shorts/")) {
    return (
      document.querySelector("ytd-shorts") ||
      document.querySelector("#shorts-container") ||
      document.querySelector("#primary-inner") ||
      document.querySelector("#primary") ||
      document.body
    );
  }
  return (
    document.querySelector("#primary-inner") ||
    document.querySelector("#primary") ||
    document.querySelector("ytd-watch-flexy")
  );
}

function ensureHideStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const watchScoped = WATCH_TITLE_SELECTORS.map(
    (sel) => `html.${PENDING_CLASS} #primary ${sel}`
  ).join(",\n");
  const shortsScoped = SHORTS_TITLE_SELECTORS.map(
    (sel) => `html.${PENDING_CLASS} ytd-shorts ${sel}`
  ).join(",\n");
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${watchScoped},\n${shortsScoped} { visibility: hidden !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function setPendingHide(on) {
  document.documentElement.classList.toggle(PENDING_CLASS, on);
}

function findTitleInWatchMetadata(meta) {
  if (!meta) return null;
  const headSelectors = [
    "h1.ytd-watch-metadata",
    "#title h1",
    "h1",
  ];
  for (const sel of headSelectors) {
    const el = meta.querySelector(sel);
    if (!el) continue;
    const t = normalizeTitle(el.textContent);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  const titleRoot = meta.querySelector("#title");
  if (titleRoot) {
    for (const fs of titleRoot.querySelectorAll("yt-formatted-string")) {
      const t = normalizeTitle(fs.textContent);
      if (t && !looksLikeTimestampOrDuration(t)) return fs;
    }
  }
  return null;
}

function findTitleElement(scope, videoId) {
  if (!scope || !videoId) return null;
  const onShorts = location.pathname.startsWith("/shorts/");

  if (!onShorts) {
    const meta = findWatchMetadataForVideo(scope, videoId);
    return findTitleInWatchMetadata(meta);
  }

  const reel = findShortsStableParent(scope, videoId);
  const reelScope = reel || scope;
  for (const sel of SHORTS_TITLE_SELECTORS) {
    const el = reelScope.querySelector(sel);
    if (!el) continue;
    const t = normalizeTitle(el.textContent);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  const shortsFormatted = reelScope.querySelectorAll(
    "yt-formatted-string.ytd-watch-metadata, yt-formatted-string#shorts-title"
  );
  let best = null;
  let bestLen = 0;
  for (const el of shortsFormatted) {
    const t = normalizeTitle(el.textContent);
    if (t && !looksLikeTimestampOrDuration(t) && t.length > bestLen) {
      best = el;
      bestLen = t.length;
    }
  }
  return best;
}

function cleanupSession() {
  sessionGeneration += 1;
  if (session) {
    if (session.observer) session.observer.disconnect();
    if (session.rafId) cancelAnimationFrame(session.rafId);
  }
  session = null;
  setPendingHide(false);
}

/**
 * @param {{ videoId: string, lock: string | null, observer: MutationObserver | null, rafId: number }} sess
 * @param {string} key
 */
function tick(sess, key) {
  if (sess !== session) return;
  const liveId = getLiveVideoId(null);
  if (liveId && liveId !== sess.videoId) {
    startSession(liveId);
    return;
  }
  const scope = getPlayerScopeRoot();
  if (!scope) return;
  const el = findTitleElement(scope, sess.videoId);
  if (!el) return;

  if (sess.lock === null) {
    const meta = findWatchMetadataForVideo(scope, sess.videoId);
    if (
      meta &&
      meta.getAttribute("video-id") &&
      meta.getAttribute("video-id") !== sess.videoId
    ) {
      return;
    }
    const t = normalizeTitle(el.textContent);
    if (!t || looksLikeTimestampOrDuration(t)) return;
    if (t !== sess._capLast) {
      sess._capLast = t;
      sess._capN = 1;
      return;
    }
    sess._capN += 1;
    if (sess._capN < 2) return;
    el.textContent = t;
    sess.lock = t;
    browser.storage.local.set({ [key]: t }).catch(() => {});
    setPendingHide(false);
    return;
  }

  if (normalizeTitle(el.textContent) !== sess.lock) {
    el.textContent = sess.lock;
  }
  setPendingHide(false);
}

async function startSession(videoId) {
  if (!videoId) return;
  const key = storageKey(videoId);
  if (session && session.videoId === videoId) {
    tick(session, key);
    return;
  }

  ensureHideStyle();
  cleanupSession();
  setPendingHide(true);
  const gen = sessionGeneration;

  const stored = await browser.storage.local.get(key);
  if (gen !== sessionGeneration) return;

  const raw = stored[key];
  let lock = null;
  if (isValidLockValue(raw)) {
    lock = normalizeTitle(typeof raw === "string" ? raw : String(raw));
    if (looksLikeTimestampOrDuration(lock)) {
      lock = null;
      browser.storage.local.remove(key).catch(() => {});
    }
  }

  /** @type {{ videoId: string, lock: string | null, observer: MutationObserver | null, rafId: number, _capLast: string, _capN: number }} */
  const sess = {
    videoId,
    lock,
    observer: null,
    rafId: 0,
    _capLast: "",
    _capN: 0,
  };
  session = sess;

  const deadline = Date.now() + PARENT_WAIT_MS;

  function attachObserver(parent) {
    if (sess !== session) return;
    if (sess.observer) sess.observer.disconnect();
    sess.observer = new MutationObserver(() => {
      tick(sess, key);
    });
    sess.observer.observe(parent, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function frame() {
    if (sess !== session) return;
    const scope = getPlayerScopeRoot();
    if (!scope || !sess.videoId) {
      if (Date.now() >= deadline) {
        setPendingHide(false);
        sess.rafId = 0;
        return;
      }
      sess.rafId = requestAnimationFrame(frame);
      return;
    }

    let parent = null;
    if (location.pathname.startsWith("/shorts/")) {
      parent = findShortsStableParent(scope, sess.videoId);
    } else {
      const meta = findWatchMetadataForVideo(scope, sess.videoId);
      parent = findStableParentForWatchMeta(meta, scope);
    }

    if (parent) {
      attachObserver(parent);
      tick(sess, key);
      sess.rafId = 0;
      return;
    }
    if (Date.now() >= deadline) {
      setPendingHide(false);
      sess.rafId = 0;
      return;
    }
    sess.rafId = requestAnimationFrame(frame);
  }

  frame();
}

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
  return link;
}

function scheduleApplyGridLocks() {
  if (gridDebounceTimer) clearTimeout(gridDebounceTimer);
  gridDebounceTimer = setTimeout(() => {
    gridDebounceTimer = null;
    void applyGridLocks();
  }, GRID_DEBOUNCE_MS);
}

async function applyGridLocks() {
  const myGen = ++gridApplyGen;
  const app = document.querySelector("ytd-app");
  if (!app) return;

  const anchors = app.querySelectorAll(GRID_LINK_SEL);
  /** @type {Map<Element, { id: string, titleEl: Element }>} */
  const byCard = new Map();
  let scanned = 0;

  for (const a of anchors) {
    if (scanned++ > GRID_SCAN_CAP) break;
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
    if (!card) continue;
    if (byCard.has(card)) continue;
    const titleEl = getGridTitleElement(card, a);
    if (!titleEl || !titleEl.textContent) continue;
    byCard.set(card, { id, titleEl });
  }

  if (byCard.size === 0) return;

  const keys = [...new Set([...byCard.values()].map((e) => storageKey(e.id)))];
  const data = await browser.storage.local.get(keys);
  if (myGen !== gridApplyGen) return;

  const toSet = {};

  for (const { id, titleEl } of byCard.values()) {
    const key = storageKey(id);
    const raw = data[key];
    let lock = null;
    if (isValidLockValue(raw)) {
      lock = normalizeTitle(String(raw));
    }
    if (lock !== null) {
      if (normalizeTitle(titleEl.textContent) !== lock) {
        titleEl.textContent = lock;
      }
    } else {
      const t = normalizeTitle(titleEl.textContent);
      if (t) {
        toSet[key] = t;
        data[key] = t;
      }
    }
  }

  if (Object.keys(toSet).length > 0) {
    await browser.storage.local.set(toSet);
  }
}

function ensureGridObserver() {
  if (gridObserver) return;
  const app = document.querySelector("ytd-app");
  if (!app) return;
  gridObserver = new MutationObserver(() => scheduleApplyGridLocks());
  gridObserver.observe(app, { childList: true, subtree: true });
}

function isWatchOrShortsUrl() {
  const p = location.pathname;
  return (
    p.startsWith("/watch") ||
    p.startsWith("/shorts/") ||
    (p === "/" && location.search.includes("v="))
  );
}

/** Single entry: resolve current video id and start or clear session. */
function runRouteSyncFromSources(navDetail) {
  ensureGridObserver();
  const id = getLiveVideoId(navDetail);
  if (!id) {
    cleanupSession();
  } else {
    startSession(id);
  }
  scheduleApplyGridLocks();
}

function scheduleRouteSync(navDetail) {
  const detail = navDetail;
  const run = () => runRouteSyncFromSources(detail);
  requestAnimationFrame(() => requestAnimationFrame(run));
}

let navResyncTimer = 0;

/** Debounced: catches SPA paths that skip yt-navigate-finish / popstate in a long-lived tab. */
function scheduleNavResync() {
  if (navResyncTimer) clearTimeout(navResyncTimer);
  navResyncTimer = setTimeout(() => {
    navResyncTimer = 0;
    if (!isWatchOrShortsUrl()) return;
    runRouteSyncFromSources(null);
  }, 280);
}

function patchHistoryForYouTubeSpa() {
  if (window.__ytTitleLockHistoryPatched) return;
  window.__ytTitleLockHistoryPatched = true;
  const wrap = (name) => {
    const orig = history[name];
    if (typeof orig !== "function") return;
    history[name] = function (...args) {
      const ret = orig.apply(this, args);
      scheduleNavResync();
      return ret;
    };
  };
  wrap("pushState");
  wrap("replaceState");
}

function ensureVideoIdNavWatcher() {
  if (window.__ytTitleLockVidObs) return;
  const attach = () => {
    const app = document.querySelector("ytd-app");
    if (!app) {
      requestAnimationFrame(attach);
      return;
    }
    const obs = new MutationObserver(() => scheduleNavResync());
    obs.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["video-id"],
    });
    window.__ytTitleLockVidObs = obs;
  };
  attach();
}

document.addEventListener(
  "yt-navigate-start",
  () => {
    ensureHideStyle();
  },
  true
);

document.addEventListener(
  "yt-navigate-finish",
  (ev) => {
    scheduleRouteSync(ev.detail);
  },
  true
);

window.addEventListener("popstate", () => scheduleRouteSync(null));

patchHistoryForYouTubeSpa();
ensureVideoIdNavWatcher();

ensureGridObserver();
scheduleApplyGridLocks();

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    runRouteSyncFromSources(null);
  })
);

setInterval(() => {
  if (!isWatchOrShortsUrl()) return;
  scheduleNavResync();
}, 4000);
