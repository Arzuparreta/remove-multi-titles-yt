/**
 * Pins the first-seen title and thumbnail per YouTube video to prevent
 * A/B-test flicker.
 *
 * Two content scripts cooperate:
 *  - `content-main.js` runs in YouTube's MAIN world and rewrites InnerTube
 *    responses (`fetch` / XHR / `ytInitialData`) before they render. That is the
 *    anti-flicker path.
 *  - This script (ISOLATED world) owns `browser.storage.local`. It is the single
 *    authority for the pin cache: it mirrors the cache into the MAIN world
 *    (SET_CACHE / PATCH_CACHE), absorbs newly learned values from MAIN (LEARN),
 *    and runs a hardened DOM reconciler as a safety net for surfaces the
 *    interception missed (Chrome document_start races, XHR getter-override
 *    failures, already-rendered DOM).
 *
 * Storage: one record per video, `ytPin:<id> = { t, th, ts }`. LRU-pruned to
 * PIN_MAX.
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
const YT_ID_STRICT_RE = /^[a-zA-Z0-9_-]{11}$/;
const PAGE_BRIDGE_SOURCE = "yt-pin-main"; // messages FROM the MAIN world
const CONTENT_BRIDGE_SOURCE = "yt-pin-content"; // messages WE send

/** DOM reconciler debounce (apply-only safety net, never learns). */
const RECONCILE_DEBOUNCE_MS = 300;
/** Delay before re-attaching observers after a layout swap. */
const RESYNC_DEBOUNCE_MS = 800;
/** Minimum ms between storage commits after learning new entries. */
const COMMIT_DEBOUNCE_MS = 500;
/** Max cards to reconcile per DOM pass. */
const DOM_SCAN_CAP = 200;
/** Max anchors to examine per DOM pass (comment timestamp links inflate this). */
const DOM_LINK_CAP = 1500;
/**
 * DOM footprint left by a third-party title un-translator (YouTube Anti
 * Translate and forks). When present it owns the visible title text, so we yield
 * titles to it and keep only our thumbnail pins (which it never touches).
 */
const TITLE_UNTRANSLATOR_MARKERS =
  'script[data-ytantitranslatesettings],[id^="yt-anti-translate-fake-node"],' +
  "[data-ytat-untranslated]," +
  "[data-ytat-untranslated-other],[data-ytat-untranslated-desc]";

/** Legacy constant — kept for unit-test compatibility with the old 2-pass gate. */
const TENTATIVE_SETTLE_MS = 750;

// --- state ---

/** In-memory pin cache: Map<videoId, {t, th, ts}>. Authoritative in this world. */
const pinCache = new Map();
/** Full records queued for the next debounced storage write. */
const pendingWrites = new Map();
let commitTimer = null;
let learnedSincePruneCheck = 0;

let reconcileTimer = null;
let resyncTimer = null;
let migrationReady = Promise.resolve();
let cacheReady = false;

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
  return typeof s === "string" && s.includes("ytimg.com") && /\/vi(_webp)?\//.test(s);
}

function isValidId(s) {
  return typeof s === "string" && YT_ID_STRICT_RE.test(s);
}

/** Whether another extension has declared ownership of visible title text. */
function hasExternalTitleOwner(root) {
  if (!root || typeof root.querySelector !== "function") return false;
  try {
    return !!root.querySelector(TITLE_UNTRANSLATOR_MARKERS);
  } catch {
    return false;
  }
}

function pinKey(id) {
  return `${PIN_PREFIX}${id}`;
}

/** Permissive merge used by migration / cache folds (keeps untouched fields). */
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

/**
 * Split a ytimg URL into stable parts. Mirror of content-main.js parseThumb.
 * The A/B variance lives in the `_custom_N` suffix; resolution and volatile
 * `sqp`/`rs` params are orthogonal.
 */
function parseThumb(url) {
  if (typeof url !== "string") return null;
  const m = url.match(
    /\/vi(_webp)?\/([a-zA-Z0-9_-]{11})\/([a-z0-9]+?)(?:_custom_(\d+))?\.(jpg|webp|png)/i
  );
  if (!m) return null;
  return {
    webp: !!m[1],
    id: m[2],
    res: m[3],
    variant: m[4] ? `_custom_${m[4]}` : "",
    ext: m[5],
  };
}

/** Clean, param-less base thumbnail URL — never expires. */
function buildBaseThumb(id, res, webp) {
  return `https://i.ytimg.com/${webp ? "vi_webp" : "vi"}/${id}/${res}.${webp ? "webp" : "jpg"}`;
}

/**
 * Conservative learn merge: fill missing fields only, and refresh a thumbnail's
 * volatile params only when it is the *same* A/B variant. Never clobbers an
 * existing title or a different thumbnail variant (that would be a leak).
 */
function learnMerge(prev, patch) {
  const next = {
    t: prev && typeof prev.t === "string" ? prev.t : null,
    th: prev && typeof prev.th === "string" ? prev.th : null,
    ts: Date.now(),
  };
  if (!next.t && isValidTitle(patch.t)) next.t = normalizeTitle(patch.t);
  if (isValidThumb(patch.th)) {
    if (!next.th) {
      next.th = patch.th;
    } else if (next.th !== patch.th) {
      const pv = parseThumb(next.th);
      const pe = parseThumb(patch.th);
      if (pv && pe && pv.variant && pv.variant === pe.variant) next.th = patch.th;
    }
  }
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
 * Storage layer.
 * ------------------------------------------------------------------ */

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

function scheduleCommit() {
  if (commitTimer) return;
  commitTimer = setTimeout(() => {
    commitTimer = null;
    void flushCommit();
  }, COMMIT_DEBOUNCE_MS);
}

async function flushCommit() {
  if (pendingWrites.size === 0) return;
  const writes = {};
  for (const [id, rec] of pendingWrites) writes[pinKey(id)] = rec;
  pendingWrites.clear();

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
 * MAIN-world bridge (this world is the cache authority).
 * ------------------------------------------------------------------ */

function sendToMain(type, payload) {
  window.postMessage({ source: CONTENT_BRIDGE_SOURCE, type, payload }, "*");
}

function sendFullCache() {
  const entries = [];
  for (const [id, rec] of pinCache) {
    if (rec && (rec.t || rec.th)) entries.push([id, { t: rec.t || null, th: rec.th || null }]);
  }
  sendToMain("SET_CACHE", { enabled, entries });
}

function sendPatch(records, enabledChanged) {
  const payload = { records };
  if (enabledChanged) payload.enabled = enabled;
  sendToMain("PATCH_CACHE", payload);
}

/** Absorb first-seen values discovered by the MAIN-world interception. */
function handleLearn(payload) {
  if (!enabled) return;
  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  let changed = false;
  for (const e of entries) {
    if (!e || !isValidId(e.id)) continue;
    if (!isValidTitle(e.t) && !isValidThumb(e.th)) continue;
    const prev = pinCache.get(e.id) || null;
    const merged = learnMerge(prev, { t: e.t, th: e.th });
    if (!prev || prev.t !== merged.t || prev.th !== merged.th) {
      pinCache.set(e.id, merged);
      pendingWrites.set(e.id, merged);
      changed = true;
    }
  }
  // MAIN already updated its mirror optimistically; the debounced commit's
  // storage.onChanged will push the canonical record back to MAIN.
  if (changed) scheduleCommit();
}

function installMainBridge() {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE_BRIDGE_SOURCE) return;

    if (msg.type === "HELLO") {
      if (cacheReady) sendFullCache();
      return;
    }
    if (msg.type === "LEARN") {
      void migrationReady.then(() => handleLearn(msg.payload));
      return;
    }
  });
}

/* ------------------------------------------------------------------ *
 * DOM read/write primitives (Trusted-Types-safe: text nodes / img.src only).
 * ------------------------------------------------------------------ */

const GRID_CARD_TAGS = new Set([
  "YTD-RICH-ITEM-RENDERER", "YTD-VIDEO-RENDERER",
  "YTD-GRID-VIDEO-RENDERER", "YTD-COMPACT-VIDEO-RENDERER",
  "YTD-RICH-GRID-MEDIA", "YTD-REEL-ITEM-RENDERER",
  "YTD-MOVIE-RENDERER", "YTD-PLAYLIST-VIDEO-RENDERER",
  "YTD-CHANNEL-VIDEO-RENDERER", "YTD-PLAYLIST-PANEL-VIDEO-RENDERER",
]);

const GRID_LINK_SEL = 'a[href*="watch?v="], a[href*="/shorts/"]';
const THUMB_IMG_SEL = 'img[src*="ytimg.com"]';

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

/**
 * Compute the URL to write into a thumbnail <img> so it shows the pinned A/B
 * variant while keeping the slot's own resolution. Returns null if no change.
 */
function thumbUrlToApply(currentUrl, pinnedTh) {
  const pv = parseThumb(pinnedTh);
  if (!pv) return null;
  const pe = parseThumb(currentUrl);
  if (!pe) return pinnedTh;
  if (pe.variant === pv.variant) return null; // already the pinned variant
  return pv.variant === "" ? buildBaseThumb(pe.id, pe.res, pe.webp) : pinnedTh;
}

const thumbFallbackBound = new WeakSet();

/** If a pinned (possibly expired custom) thumbnail fails, revert to native. */
function bindThumbFallback(img) {
  if (thumbFallbackBound.has(img)) return;
  thumbFallbackBound.add(img);
  img.addEventListener("error", function onErr() {
    const native = img.getAttribute("data-ytpin-native");
    if (!native || img.getAttribute("data-ytpin-reverted")) return;
    img.setAttribute("data-ytpin-reverted", "1");
    if (img.src !== native) img.src = native;
  });
}

function setPinnedThumbnail(container, pinnedTh) {
  if (!container || !isValidThumb(pinnedTh)) return;
  // Only ever touch a real ytimg <img>; never stamp onto avatars/placeholders.
  const img = container.querySelector(THUMB_IMG_SEL);
  if (!img) return;
  const cur = img.getAttribute("src") || img.src || "";
  const next = thumbUrlToApply(cur, pinnedTh);
  if (!next || img.src === next) return;
  // We only reach here when `cur` is a non-pinned (native/other) URL, so it is
  // exactly the value to fall back to. Refresh it every time so a recycled <img>
  // never reverts to a previous video's thumbnail.
  if (cur) {
    img.setAttribute("data-ytpin-native", cur);
    img.removeAttribute("data-ytpin-reverted");
    bindThumbFallback(img);
  }
  img.src = next;
}

/* ------------------------------------------------------------------ *
 * DOM reconciler (apply-only safety net; never learns).
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

/** The video id a card currently resolves to (used as a recycling guard). */
function cardVideoId(card) {
  const a = card.querySelector(GRID_LINK_SEL);
  const href = a?.getAttribute("href");
  if (!href) return null;
  try {
    return extractVideoId(new URL(href, location.origin).href);
  } catch {
    return null;
  }
}

function applyToCard(card, link, id, rec, applyTitles) {
  const href = link.getAttribute("href") || "";
  const isShort =
    href.startsWith("/shorts/") ||
    card.nodeName === "YTD-REEL-ITEM-RENDERER" ||
    !!card.closest("ytd-shorts");

  if (applyTitles && isValidTitle(rec.t)) {
    const titleEl = getGridTitleElement(card, link);
    if (titleEl && currentTitleText(titleEl) !== normalizeTitle(rec.t)) {
      setPinnedTitleText(titleEl, rec.t);
    }
  }
  // Never cross-apply a (horizontal) video thumbnail onto a Shorts slot.
  if (!isShort && isValidThumb(rec.th)) {
    setPinnedThumbnail(card.querySelector("ytd-thumbnail") || card, rec.th);
  }
}

async function reconcileDom() {
  await migrationReady;
  if (!enabled) return;

  // A title-untranslator intentionally owns the visible text. Re-applying our
  // stored title would create an endless MutationObserver ping-pong; thumbnail
  // pins remain independent and are still reconciled below.
  const applyTitles = !hasExternalTitleOwner(document);

  const roots = [
    "#contents", "ytd-miniplayer", "ytd-shorts",
    "#secondary", "#primary-inner", "#primary",
  ];
  const seen = new Set();
  let applied = 0;
  let examined = 0;

  for (const sel of roots) {
    for (const root of document.querySelectorAll(sel)) {
      if (!root.isConnected) continue;
      for (const a of root.querySelectorAll(GRID_LINK_SEL)) {
        if (applied >= DOM_SCAN_CAP || examined >= DOM_LINK_CAP) return;
        examined++;
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
        const rec = pinCache.get(id);
        if (!rec) continue;
        // Recycling guard: the card must still resolve to this id.
        if (cardVideoId(card) !== id) continue;
        applyToCard(card, a, id, rec, applyTitles);
        applied++;
      }
    }
  }
}

/**
 * Trailing-edge throttle (not a resetting debounce): once a pass is pending it
 * is not pushed back by further mutations, so continuous churn (comments, live
 * chat) can never starve the reconciler.
 */
function scheduleReconcile() {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileDom();
  }, RECONCILE_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ *
 * Watch / Shorts title reconciler.
 * ------------------------------------------------------------------ */

async function applyWatchTitle() {
  await migrationReady;
  if (!enabled) return;
  if (hasExternalTitleOwner(document)) return;

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
      const host = meta || scope;
      for (const sel of ["h1.ytd-watch-metadata", "#title h1", "h1"]) {
        const el = host.querySelector(sel);
        if (el && currentTitleText(el) !== pinned) {
          setPinnedTitleText(el, pinned);
          break;
        }
      }
    }
  }
}

function applyAll() {
  scheduleReconcile();
  void applyWatchTitle();
}

/* ------------------------------------------------------------------ *
 * Scoped, debounced subtree observers (safety net for scroll/lazy surfaces).
 * `#secondary` is intentionally excluded (it mutates constantly); it is still
 * scanned on nav/data triggers via reconcileDom's root list.
 * ------------------------------------------------------------------ */

let subtreeObserver = null;

function attachObservers() {
  if (typeof MutationObserver === "undefined") return;
  if (!subtreeObserver) {
    subtreeObserver = new MutationObserver(() => scheduleReconcile());
  } else {
    subtreeObserver.disconnect();
  }
  // Observe only the infinite-scroll grid feeds. Comments / live chat / player
  // (under #primary-inner) churn constantly and are covered by the interception
  // layer and event-driven reconciles instead.
  for (const sel of ["#contents", "ytd-shorts"]) {
    for (const el of document.querySelectorAll(sel)) {
      if (el.isConnected) {
        subtreeObserver.observe(el, { childList: true, subtree: true });
      }
    }
  }
}

function scheduleResync() {
  if (resyncTimer) clearTimeout(resyncTimer);
  resyncTimer = setTimeout(() => {
    resyncTimer = null;
    attachObservers();
  }, RESYNC_DEBOUNCE_MS);
}

/* ------------------------------------------------------------------ *
 * Bootstrap.
 * ------------------------------------------------------------------ */

if (typeof document !== "undefined" && typeof browser !== "undefined") {
  installMainBridge();

  migrationReady = migrateLegacyIfNeeded().then(async () => {
    await loadPinCache();
    cacheReady = true;
    sendFullCache(); // push snapshot to MAIN (covers a HELLO we already got)
    attachObservers();
    applyAll();
  });

  // Cross-tab / own-commit sync: update the cache and mirror deltas to MAIN.
  if (browser.storage?.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let enabledChanged = false;
      if (Object.prototype.hasOwnProperty.call(changes, ENABLED_KEY)) {
        enabled = changes[ENABLED_KEY].newValue !== false;
        enabledChanged = true;
      }
      const records = [];
      for (const k of Object.keys(changes)) {
        if (!k.startsWith(PIN_PREFIX)) continue;
        const id = k.slice(PIN_PREFIX.length);
        const nv = changes[k].newValue;
        if (nv && typeof nv === "object" && (nv.t || nv.th)) {
          pinCache.set(id, nv);
          records.push([id, { t: nv.t || null, th: nv.th || null }]);
        } else {
          pinCache.delete(id);
          records.push([id, null]);
        }
      }
      if (records.length || enabledChanged) sendPatch(records, enabledChanged);
      if (enabledChanged && enabled) applyAll();
    });
  }

  // React to YouTube's own navigation events + webNavigation SPA signal.
  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ytTitleLockHistoryState") {
      applyAll();
      scheduleResync();
    }
  });

  for (const evt of ["yt-navigate-finish", "yt-page-data-updated"]) {
    document.addEventListener(
      evt,
      () => {
        applyAll();
        scheduleResync();
      },
      true
    );
  }

  window.addEventListener("popstate", () => applyAll());

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void migrationReady.then(applyAll);
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
    isValidId,
    hasExternalTitleOwner,
    extractVideoId,
    extractVideoIdFromYtNavigateDetail,
    mergeRecord,
    learnMerge,
    parseThumb,
    buildBaseThumb,
    thumbUrlToApply,
    selectKeysToEvict,
    PIN_PREFIX,
    PIN_MAX,
    TENTATIVE_SETTLE_MS,
  };
}
