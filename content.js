/**
 * Pins first-seen titles per YouTube video (watch, Shorts, grid cards).
 *
 * Approach: after each navigation we read the official video id (yt-navigate-finish
 * detail or URL), then apply storage ↔ title in a few timed attempts. We do not
 * attach MutationObservers to the title area or hide native text — that fought YouTube
 * and caused stuck / flickering titles.
 *
 * Compatibility: pin text targets yt-formatted-string when present (keeps heading shape),
 * avoids writing whole-card anchors, scopes list MutationObservers away from the player,
 * and uses webNavigation (background) instead of patching history. Title text is updated
 * by mutating text nodes in place (and open shadow subtrees) instead of assigning
 * textContent on the component, which was destroying internal structure and could break
 * layout/hit-testing (e.g. sidebar thumbnail clicks).
 *
 * We do not attach subtree MutationObservers to #secondary: the recommendations column
 * mutates constantly (hover, lazy-load, our title pins). Each batch schedules
 * applyGridLocks and can race YouTube’s SPA handler on thumbnail clicks — the UI
 * shows active state but navigation never completes. Sidebar tiles are still scanned
 * whenever grid locks run (navigation, #contents mutations, etc.).
 */

const STORAGE_PREFIX = "ytTitleLock:";
const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;
const GRID_DEBOUNCE_MS = 300;
const GRID_RESYNC_DEBOUNCE_MS = 800;
const NAV_APPLY_DEBOUNCE_MS = 64;
const PLAYER_RETRY_MS = [0, 150, 400, 900];

/** Subtree observers: exclude #secondary (see file comment). */
const GRID_OBSERVER_ROOT_SELECTORS = [
  "#contents",
  "ytd-miniplayer",
  "ytd-shorts",
];

/** Anchor scan roots: #secondary first so cap still covers watch sidebar when #contents is huge. */
const GRID_SCAN_ROOT_SELECTORS = [
  "#secondary",
  "#contents",
  "ytd-miniplayer",
  "ytd-shorts",
];

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
 * Video links inside comments are not rescanned until another list mutation or navigation.
 */
const PRIMARY_INNER_IGNORE_SEL =
  "ytd-comments, #comments, ytd-live-chat-renderer, #chat";

let gridSubtreeObservers = [];
let gridAppStructureObserver = null;
let gridResyncTimer = null;
let gridDebounceTimer = null;
let gridApplyGen = 0;
let navApplyTimer = 0;
/** @type {{ root: Element; filterPrimaryInner: boolean }[] | null} */
let lastGridLayoutRoots = null;

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
  if (!t || t === "undefined") return false;
  return true;
}

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

/** Prefer YouTube’s navigate payload; else URL (watch ?v= or Shorts path). */
function currentPlayerVideoId(navDetail) {
  const fromNav = extractVideoIdFromYtNavigateDetail(navDetail);
  if (fromNav) return fromNav;
  if (location.pathname.startsWith("/shorts/")) {
    const m = location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }
  return extractVideoId(location.href);
}

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

/**
 * Meaningful text nodes under a root (light DOM + open shadow roots), document order.
 * Skips script/style; avoids replacing textContent on yt-formatted-string internals.
 */
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

function setPinnedTitleText(host, pin) {
  const target = getPinTextTarget(host);
  if (!target) return;
  const lock = normalizeTitle(pin);
  if (normalizeTitle(target.textContent) === lock) return;

  const maxNodes = 48;
  const nodes = collectMeaningfulTextNodes(target, maxNodes);
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
    const t = normalizeTitle(getPinTextTarget(el).textContent);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  return null;
}

function findShortsTitleElement() {
  const scope =
    document.querySelector("ytd-shorts") ||
    document.querySelector("#shorts-container") ||
    document.body;
  for (const sel of [
    "h1.ytd-watch-metadata",
    "h2.ytd-shorts-title",
    "#title h1",
  ]) {
    const el = scope.querySelector(sel);
    if (!el) continue;
    const t = normalizeTitle(getPinTextTarget(el).textContent);
    if (t && !looksLikeTimestampOrDuration(t)) return el;
  }
  return null;
}

async function applyPlayerTitle(navDetail) {
  const videoId = currentPlayerVideoId(navDetail);
  if (!videoId) return;

  const onShorts = location.pathname.startsWith("/shorts/");
  const key = storageKey(videoId);
  let lock = null;
  try {
    const stored = await browser.storage.local.get(key);
    const raw = stored[key];
    if (isValidLockValue(raw)) {
      lock = normalizeTitle(String(raw));
      if (looksLikeTimestampOrDuration(lock)) lock = null;
    }
  } catch {
    return;
  }

  const pickEl = () =>
    onShorts ? findShortsTitleElement() : findWatchTitleElement(videoId);

  let cumulative = 0;
  for (let i = 0; i < PLAYER_RETRY_MS.length; i++) {
    const wait = PLAYER_RETRY_MS[i] - cumulative;
    cumulative = PLAYER_RETRY_MS[i];
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    const el = pickEl();
    if (!el) continue;

    if (lock !== null) {
      setPinnedTitleText(el, lock);
    } else {
      const native = normalizeTitle(getPinTextTarget(el).textContent);
      if (native && !looksLikeTimestampOrDuration(native)) {
        try {
          await browser.storage.local.set({ [key]: native });
        } catch {
          /* ignore */
        }
      }
    }
    return;
  }
}

function scheduleApplyPlayerTitle(navDetail) {
  if (navApplyTimer) clearTimeout(navApplyTimer);
  const d = navDetail;
  navApplyTimer = setTimeout(() => {
    navApplyTimer = 0;
    void applyPlayerTitle(d);
  }, NAV_APPLY_DEBOUNCE_MS);
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
  if (link.querySelector("ytd-thumbnail, img")) return null;
  return link;
}

function scheduleApplyGridLocks() {
  if (gridDebounceTimer) clearTimeout(gridDebounceTimer);
  gridDebounceTimer = setTimeout(() => {
    gridDebounceTimer = null;
    void applyGridLocks();
  }, GRID_DEBOUNCE_MS);
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

function gridLayoutRootsMatch(
  prev,
  next
) {
  if (!prev || !next || prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i].filterPrimaryInner !== next[i].filterPrimaryInner) return false;
    if (prev[i].root !== next[i].root) return false;
    if (!prev[i].root.isConnected) return false;
  }
  return true;
}

function anchorLooksLikeGridLink(el) {
  if (!el || el.nodeName !== "A") return false;
  const href = el.getAttribute("href");
  if (!href) return false;
  return href.includes("watch?v=") || href.includes("/shorts/");
}

/**
 * First GRID_SCAN_CAP watch/shorts anchors under scan roots (includes #secondary),
 * stopping early (no full ytd-app querySelectorAll).
 */
function collectFirstGridAnchors(maxCount) {
  const out = [];
  outer: for (const { root, filterPrimaryInner } of getGridScanRoots()) {
    if (!root.isConnected) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        if (
          filterPrimaryInner &&
          node.matches(PRIMARY_INNER_IGNORE_SEL)
        ) {
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
  const playerSel =
    "ytd-player, #movie_player, video.html5-main-video, .html5-video-container";
  for (const m of mutations) {
    let t = m.target;
    if (t.nodeType === Node.TEXT_NODE) t = t.parentElement;
    if (!t || typeof t.closest !== "function") continue;
    if (t.closest(playerSel)) continue;
    if (t.closest(PRIMARY_INNER_IGNORE_SEL)) continue;
    return true;
  }
  return false;
}

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
      gridAppStructureObserver = new MutationObserver(() =>
        scheduleResyncGridObservers()
      );
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

async function applyGridLocks() {
  const myGen = ++gridApplyGen;
  if (!document.querySelector("ytd-app")) return;

  const anchors = collectFirstGridAnchors(GRID_SCAN_CAP);
  const byCard = new Map();

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
    if (!card || byCard.has(card)) continue;
    const titleEl = getGridTitleElement(card, a);
    if (!titleEl || !getPinTextTarget(titleEl).textContent) continue;
    byCard.set(card, { id, titleEl });
  }

  if (byCard.size === 0) return;

  const keys = [...new Set([...byCard.values()].map((e) => storageKey(e.id)))];
  let data;
  try {
    data = await browser.storage.local.get(keys);
  } catch {
    return;
  }
  if (myGen !== gridApplyGen) return;

  const toSet = {};
  for (const { id, titleEl } of byCard.values()) {
    const k = storageKey(id);
    const raw = data[k];
    let pin = null;
    if (isValidLockValue(raw)) {
      pin = normalizeTitle(String(raw));
    }
    if (pin !== null) {
      if (normalizeTitle(getPinTextTarget(titleEl).textContent) !== pin) {
        setPinnedTitleText(titleEl, pin);
      }
    } else {
      const t = normalizeTitle(getPinTextTarget(titleEl).textContent);
      if (t) {
        toSet[k] = t;
        data[k] = t;
      }
    }
  }

  if (Object.keys(toSet).length > 0) {
    try {
      await browser.storage.local.set(toSet);
    } catch {
      /* ignore */
    }
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "ytTitleLockHistoryState") {
    scheduleApplyPlayerTitle(null);
    scheduleApplyGridLocks();
  }
});

document.addEventListener(
  "yt-navigate-finish",
  (ev) => {
    scheduleApplyPlayerTitle(ev.detail);
    scheduleApplyGridLocks();
    syncGridObservers();
  },
  true
);

window.addEventListener("popstate", () => {
  scheduleApplyPlayerTitle(null);
  scheduleApplyGridLocks();
  syncGridObservers();
});

syncGridObservers();

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    scheduleApplyPlayerTitle(null);
    scheduleApplyGridLocks();
    syncGridObservers();
  })
);
