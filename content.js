/**
 * Pins first-seen title per video on YouTube Watch / Shorts; re-applies after DOM swaps.
 * Depends on lib/browser-polyfill.min.js for cross-browser storage promises.
 */

const TITLE_SELECTORS = [
  "h1.ytd-watch-metadata",
  "ytd-watch-metadata h1",
  "#title h1",
  "yt-formatted-string.ytd-watch-metadata",
];

const PENDING_CLASS = "yt-title-lock-pending";
const STYLE_ID = "yt-title-lock-style";
const STORAGE_PREFIX = "ytTitleLock:";
const PARENT_WAIT_MS = 15000;

const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;

/** @type {{ videoId: string, lock: string | null, observer: MutationObserver | null, rafId: number } | null} */
let session = null;
let sessionGeneration = 0;

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

function ensureHideStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const rules = TITLE_SELECTORS.map(
    (sel) => `html.${PENDING_CLASS} ${sel}`
  ).join(",\n");
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `${rules} { visibility: hidden !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function setPendingHide(on) {
  document.documentElement.classList.toggle(PENDING_CLASS, on);
}

function findTitleElement() {
  for (const sel of TITLE_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const t = normalizeTitle(el.textContent);
    if (t) return el;
  }
  return null;
}

function findStableParent() {
  return (
    document.querySelector("#above-the-fold") ||
    document.querySelector("#title") ||
    document.querySelector("ytd-watch-metadata") ||
    null
  );
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
  const el = findTitleElement();
  if (!el) return;

  if (sess.lock === null) {
    const t = normalizeTitle(el.textContent);
    if (!t) return;
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
  ensureHideStyle();
  cleanupSession();
  setPendingHide(true);
  const gen = sessionGeneration;

  const key = storageKey(videoId);
  const stored = await browser.storage.local.get(key);
  if (gen !== sessionGeneration) return;

  const raw = stored[key];
  let lock = null;
  if (isValidLockValue(raw)) {
    lock = normalizeTitle(typeof raw === "string" ? raw : String(raw));
  }

  /** @type {{ videoId: string, lock: string | null, observer: MutationObserver | null, rafId: number }} */
  const sess = {
    videoId,
    lock,
    observer: null,
    rafId: 0,
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
    const parent = findStableParent();
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

function onRouteChange() {
  const id = extractVideoId(location.href);
  if (!id) {
    cleanupSession();
    return;
  }
  startSession(id);
}

document.addEventListener(
  "yt-navigate-start",
  () => {
    ensureHideStyle();
    setPendingHide(true);
  },
  true
);

document.addEventListener("yt-navigate-finish", onRouteChange, true);
window.addEventListener("popstate", onRouteChange);

const initialId = extractVideoId(location.href);
if (initialId) startSession(initialId);
