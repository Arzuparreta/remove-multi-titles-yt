/**
 * ISOLATED-world half of the extension: owns the pin store.
 *
 * content-main.js (MAIN world) extracts video entries from YouTube's JSON and
 * asks this script, through a synchronous CustomEvent, which pins apply. This
 * script answers from an in-memory cache, learns first-seen values, and
 * persists them to browser.storage in the background.
 *
 * Storage: one record per video, `ytPin:<id> = { t, th, tv, ts }`
 *   t   first-seen title
 *   th  first-seen landscape thumbnail URL
 *   tv  first-seen vertical (Shorts) thumbnail URL
 *   ts  last time the video was seen (LRU)
 * YouTube Music uses its own namespace (`ytPin:m:<id>`): it shows song titles
 * for the same video ids, so its pins must not mix with youtube.com's.
 */

const PIN_PREFIX = "ytPin:";
const ENABLED_KEY = "ytPinEnabled";
const SCHEMA_KEY = "ytPinSchema";
const SCHEMA_VERSION = 3;
const LEGACY_TITLE_PREFIX = "ytTitleLock:";
const LEGACY_THUMB_PREFIX = "ytThumbLock:";

const PIN_MAX = 5000;
/** Prune only once the cache exceeds PIN_MAX by this much (hysteresis). */
const PRUNE_SLACK = 250;
/** Refresh a record's LRU timestamp at most this often. */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const COMMIT_DEBOUNCE_MS = 1000;
/** Migration: a title pinned for this many videos is a UI label, not a title. */
const SHARED_TITLE_LIMIT = 3;
const MAX_QUERY_ITEMS = 5000;

const EVT_QUERY = "ytpin:q";
const EVT_ANSWER = "ytpin:a";
const EVT_STATE = "ytpin:state";

/* ------------------------------------------------------------------ *
 * Pure helpers (exported for unit tests).
 * ------------------------------------------------------------------ */

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CACHE_KEY_RE = /^(?:m:)?[A-Za-z0-9_-]{11}$/;

function isVideoId(s) {
  return typeof s === "string" && VIDEO_ID_RE.test(s);
}

function normalizeTitle(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function isValidTitle(s) {
  if (typeof s !== "string") return false;
  const t = normalizeTitle(s);
  if (!t || t === "undefined" || t.length > 500) return false;
  if (/^\d{1,3}:\d{2}(:\d{2})?$/.test(t)) return false;
  return true;
}

function isValidThumb(s) {
  return typeof s === "string" && s.length < 1000 && /^https:\/\/i\d?\.ytimg\.com\/vi(?:_[a-z]+)*\//.test(s);
}

/** "h" landscape, "v" vertical Shorts art, "f" raw video frame (never a pin). */
function thumbFamily(url) {
  const name = /\/([^/?#.]+)\.(?:jpg|webp)(?:[?#]|$)/i.exec(url)?.[1] || "";
  if (/^frame\d/.test(name)) return "f";
  if (/^(oar|sar)/.test(name)) return "v";
  return "h";
}

function cacheKey(ns, id) {
  return ns ? `${ns}:${id}` : id;
}

function mergeRecord(prev, patch, now = Date.now()) {
  return {
    t: patch.t ?? prev?.t ?? null,
    th: patch.th ?? prev?.th ?? null,
    tv: patch.tv ?? prev?.tv ?? null,
    ts: now,
  };
}

/**
 * Resolves a bridge query against the cache. Learns first-seen values from
 * items flagged `learn` (the first occurrence of an id wins), refreshes LRU
 * timestamps, and returns the pins for every known id plus the cache keys
 * that need persisting.
 */
function resolveItems(cache, items, ns, now = Date.now()) {
  const pins = {};
  const dirty = [];
  for (const it of items) {
    if (!it || !isVideoId(it.id)) continue;
    const key = cacheKey(ns, it.id);
    const rec = cache.get(key) || null;
    let next = rec;
    if (it.learn === true) {
      const patch = {};
      if (!isValidTitle(rec?.t) && isValidTitle(it.t)) patch.t = normalizeTitle(it.t);
      if (isValidThumb(it.th)) {
        if (it.fam === "h" && !rec?.th && thumbFamily(it.th) === "h") patch.th = it.th;
        else if (it.fam === "v" && !rec?.tv && thumbFamily(it.th) === "v") patch.tv = it.th;
      }
      if (patch.t || patch.th || patch.tv) next = mergeRecord(rec, patch, now);
    }
    if (next && next === rec && now - (rec.ts || 0) > TOUCH_AFTER_MS) next = { ...rec, ts: now };
    if (next !== rec) {
      cache.set(key, next);
      dirty.push(key);
    }
    if (next && !(it.id in pins)) pins[it.id] = { t: next.t ?? null, th: next.th ?? null, tv: next.tv ?? null };
  }
  return { pins, dirty };
}

/**
 * Drops thumbnail pins that failed to load (`fam` "h" → th, "v" → tv), so the
 * next response shows and re-learns YouTube's current thumbnail.
 */
function forgetThumbs(cache, forget, ns, now = Date.now()) {
  const dirty = [];
  for (const f of forget) {
    if (!f || !isVideoId(f.id)) continue;
    const key = cacheKey(ns, f.id);
    const rec = cache.get(key);
    const field = f.fam === "v" ? "tv" : "th";
    if (!rec || !rec[field]) continue;
    cache.set(key, { ...rec, [field]: null, ts: now });
    dirty.push(key);
  }
  return dirty;
}

/**
 * First write wins per field: values already in storage beat ours, except
 * thumbnails this tab just forgot because they no longer load.
 */
function mergeStored(stored, mine, forgotten) {
  const s = stored && typeof stored === "object" ? stored : {};
  const thumb = (field) =>
    forgotten?.has(field) ? mine[field] ?? null : isValidThumb(s[field]) ? s[field] : mine[field] ?? null;
  return {
    t: isValidTitle(s.t) ? s.t : mine.t ?? null,
    th: thumb("th"),
    tv: thumb("tv"),
    ts: Math.max(Number(s.ts) || 0, Number(mine.ts) || 0),
  };
}

/** Oldest cache keys (by `ts`) to drop so that `max` remain. */
function selectKeysToEvict(cache, max) {
  if (cache.size <= max) return [];
  return [...cache.entries()]
    .sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0))
    .slice(0, cache.size - max)
    .map((e) => e[0]);
}

/** Cleans one stored record; null when nothing usable is left. */
function sanitizeRecord(v) {
  if (!v || typeof v !== "object") return null;
  const rec = {
    t: isValidTitle(v.t) ? normalizeTitle(v.t) : null,
    th: null,
    tv: isValidThumb(v.tv) && thumbFamily(v.tv) === "v" ? v.tv : null,
    ts: Number(v.ts) || 0,
  };
  if (isValidThumb(v.th)) {
    const fam = thumbFamily(v.th);
    if (fam === "h") rec.th = v.th;
    else if (fam === "v" && !rec.tv) rec.tv = v.th;
  }
  return rec;
}

function sameRecord(a, b) {
  return (a.t ?? null) === (b.t ?? null) && (a.th ?? null) === (b.th ?? null) && (a.tv ?? null) === (b.tv ?? null) && (a.ts || 0) === (b.ts || 0);
}

/**
 * Schema v3 migration over a full storage dump. Folds legacy
 * ytTitleLock:/ytThumbLock: keys, drops non-video ids (playlists, mixes),
 * raw-frame thumbnails and "titles" shared by many videos (UI labels such as
 * "Up next" that v2.4 captured), and fixes up record shapes.
 * Returns the storage writes (changed records only) and removals to perform.
 */
function planMigration(all) {
  const records = new Map();
  const remove = [];

  for (const k in all) {
    if (!k.startsWith(PIN_PREFIX)) continue;
    const ck = k.slice(PIN_PREFIX.length);
    const rec = CACHE_KEY_RE.test(ck) ? sanitizeRecord(all[k]) : null;
    if (!rec) remove.push(k);
    else records.set(ck, rec);
  }

  for (const k in all) {
    const isTitle = k.startsWith(LEGACY_TITLE_PREFIX);
    const isThumb = k.startsWith(LEGACY_THUMB_PREFIX);
    if (!isTitle && !isThumb) continue;
    remove.push(k);
    const id = k.slice((isTitle ? LEGACY_TITLE_PREFIX : LEGACY_THUMB_PREFIX).length);
    if (!isVideoId(id)) continue;
    const rec = records.get(id) || { t: null, th: null, tv: null, ts: 0 };
    if (isTitle && !rec.t && isValidTitle(all[k])) rec.t = normalizeTitle(all[k]);
    if (isThumb && !rec.th && isValidThumb(all[k]) && thumbFamily(all[k]) === "h") rec.th = all[k];
    records.set(id, rec);
  }

  const titleUses = new Map();
  for (const rec of records.values()) if (rec.t) titleUses.set(rec.t, (titleUses.get(rec.t) || 0) + 1);

  const set = { [SCHEMA_KEY]: SCHEMA_VERSION };
  for (const [ck, rec] of records) {
    if (rec.t && titleUses.get(rec.t) >= SHARED_TITLE_LIMIT) rec.t = null;
    const key = PIN_PREFIX + ck;
    if (!rec.t && !rec.th && !rec.tv) remove.push(key);
    else if (!all[key] || !sameRecord(rec, all[key])) set[key] = rec;
  }
  return { set, remove };
}

/* ------------------------------------------------------------------ *
 * Runtime.
 * ------------------------------------------------------------------ */

function bootContent() {
  const api = globalThis.browser ?? globalThis.chrome;
  const cache = new Map();
  const dirty = new Set();
  /** cache key → thumbnail fields forgotten since the last flush. */
  const forgotten = new Map();
  let ready = false;
  let enabled = true;
  let commitTimer = null;

  function emitState() {
    document.dispatchEvent(new CustomEvent(EVT_STATE, { detail: JSON.stringify({ ready, enabled }) }));
  }

  document.addEventListener(EVT_QUERY, (e) => {
    let req = null;
    try {
      req = JSON.parse(e.detail);
    } catch {
      /* ignore */
    }
    const reply = { ready, enabled, pins: {} };
    const ns = req?.ns === "m" ? "m" : "";
    if (ready && enabled && Array.isArray(req?.items) && req.items.length <= MAX_QUERY_ITEMS) {
      const { pins, dirty: changed } = resolveItems(cache, req.items, ns);
      reply.pins = pins;
      markDirty(changed);
    }
    if (ready && Array.isArray(req?.forget) && req.forget.length <= MAX_QUERY_ITEMS) {
      const changed = forgetThumbs(cache, req.forget, ns);
      for (const k of changed) {
        const f = forgotten.get(k) || new Set();
        for (const item of req.forget) if (cacheKey(ns, item?.id) === k) f.add(item.fam === "v" ? "tv" : "th");
        forgotten.set(k, f);
      }
      markDirty(changed);
    }
    document.dispatchEvent(new CustomEvent(EVT_ANSWER, { detail: JSON.stringify(reply) }));
  });

  function markDirty(keys) {
    if (!keys.length) return;
    for (const k of keys) dirty.add(k);
    scheduleCommit();
  }

  function scheduleCommit() {
    if (commitTimer) return;
    commitTimer = setTimeout(() => {
      commitTimer = null;
      void flush();
    }, COMMIT_DEBOUNCE_MS);
  }

  async function flush() {
    if (!dirty.size) return;
    const keys = [...dirty];
    dirty.clear();
    let stored = {};
    try {
      stored = await api.storage.local.get(keys.map((k) => PIN_PREFIX + k));
    } catch {
      /* extension context gone; keep the in-memory values */
    }
    const writes = {};
    for (const k of keys) {
      const mine = cache.get(k);
      if (!mine) continue;
      const merged = mergeStored(stored[PIN_PREFIX + k], mine, forgotten.get(k));
      forgotten.delete(k);
      cache.set(k, merged);
      writes[PIN_PREFIX + k] = merged;
    }
    try {
      await api.storage.local.set(writes);
    } catch {
      /* ignore */
    }
    prune();
  }

  function prune() {
    if (cache.size <= PIN_MAX + PRUNE_SLACK) return;
    const evict = selectKeysToEvict(cache, PIN_MAX);
    for (const k of evict) {
      cache.delete(k);
      dirty.delete(k);
    }
    api.storage.local.remove(evict.map((k) => PIN_PREFIX + k)).catch(() => {});
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k in changes) {
      if (k === ENABLED_KEY) {
        enabled = changes[k].newValue !== false;
        emitState();
      } else if (k.startsWith(PIN_PREFIX)) {
        const v = changes[k].newValue;
        const ck = k.slice(PIN_PREFIX.length);
        // Keep values learned here that are still waiting to be written.
        if (v && typeof v === "object") cache.set(ck, dirty.has(ck) && cache.has(ck) ? mergeStored(v, cache.get(ck)) : v);
        else cache.delete(ck);
      }
    }
  });

  // Best effort: persist what was learned before the tab goes away.
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });

  (async () => {
    emitState();
    let all = {};
    try {
      all = await api.storage.local.get(null);
      if ((Number(all[SCHEMA_KEY]) || 0) < SCHEMA_VERSION) {
        const plan = planMigration(all);
        await api.storage.local.set(plan.set);
        if (plan.remove.length) await api.storage.local.remove(plan.remove);
        for (const k of plan.remove) delete all[k];
        Object.assign(all, plan.set);
      }
    } catch {
      /* start with whatever was read */
    }
    enabled = all[ENABLED_KEY] !== false;
    for (const k in all) {
      if (k.startsWith(PIN_PREFIX) && all[k] && typeof all[k] === "object") {
        cache.set(k.slice(PIN_PREFIX.length), all[k]);
      }
    }
    ready = true;
    emitState();
    prune();
  })();
}

if (typeof window === "undefined") {
  if (typeof module === "object" && module.exports) {
    module.exports = {
      PIN_PREFIX, PIN_MAX, SCHEMA_KEY, SCHEMA_VERSION, TOUCH_AFTER_MS,
      isVideoId, normalizeTitle, isValidTitle, isValidThumb, thumbFamily, cacheKey,
      mergeRecord, resolveItems, forgetThumbs, mergeStored, selectKeysToEvict, sanitizeRecord, planMigration,
    };
  }
} else {
  bootContent();
}
