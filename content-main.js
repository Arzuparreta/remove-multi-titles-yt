/**
 * Runs in YouTube's MAIN world (document_start).
 *
 * Patches page-owned surfaces an isolated content script cannot reach —
 * `fetch`, `XMLHttpRequest`, and the `ytInitialData` / `ytInitialPlayerResponse`
 * globals — and rewrites the first-seen title/thumbnail into InnerTube responses
 * *before* YouTube renders them. This is the anti-flicker layer.
 *
 * It has no extension APIs, so `content.js` (ISOLATED world) owns storage and
 * mirrors the pin cache here via postMessage (SET_CACHE / PATCH_CACHE). Because
 * the mirror lives in this world, every lookup is SYNCHRONOUS: there is no
 * per-response round-trip and nothing blocks `fetch` resolution. Newly learned
 * first-seen values are pushed back with a fire-and-forget LEARN message.
 *
 * Pure helpers here are intentionally duplicated from content.js (the two worlds
 * are separate JS realms with no shared module system). Keep them in sync.
 */

(() => {
  const PAGE_SOURCE = "yt-pin-main";
  const CONTENT_SOURCE = "yt-pin-content";
  const YT_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
  const YT_API_RE = /\/youtubei\/v1\/([^?]+)/;
  const ENDPOINT_RE = /^(player|next|browse|search|reel)/;
  const MAX_ENTRIES = 1500;

  /** videoId -> { t, th }. Mirror of the ISOLATED-world pin cache. */
  const cache = new Map();
  let enabled = true;
  let cacheReady = false;

  /* --------------------------------------------------------------- *
   * Pure helpers (mirror of content.js).
   * --------------------------------------------------------------- */

  function normalizeTitle(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function isValidTitle(s) {
    const t = normalizeTitle(s);
    if (!t || t === "undefined") return false;
    if (/^\d{1,3}:\d{2}:\d{2}$/.test(t)) return false;
    if (/^\d{1,2}:\d{2}$/.test(t)) return false;
    return true;
  }

  function isValidThumb(s) {
    return typeof s === "string" && s.includes("ytimg.com") && /\/vi(_webp)?\//.test(s);
  }

  function isValidId(s) {
    return typeof s === "string" && YT_ID_RE.test(s);
  }

  /**
   * Split a ytimg URL into its stable parts. The A/B-test variance lives in the
   * name stem's `_custom_N` suffix; the resolution keyword and volatile
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

  /* --------------------------------------------------------------- *
   * InnerTube read/write.
   * --------------------------------------------------------------- */

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
    if (obj.title?.runs?.[0]) {
      obj.title.runs.length = 1;
      obj.title.runs[0].text = text;
      return true;
    }
    if (obj.title?.simpleText !== undefined) { obj.title.simpleText = text; return true; }
    if (obj.headline?.simpleText !== undefined) { obj.headline.simpleText = text; return true; }
    if (obj.metadata?.lockupMetadataViewModel?.title) {
      obj.metadata.lockupMetadataViewModel.title.content = text;
      return true;
    }
    if (obj.videoPrimaryInfoRenderer?.title?.runs?.[0]) {
      obj.videoPrimaryInfoRenderer.title.runs.length = 1;
      obj.videoPrimaryInfoRenderer.title.runs[0].text = text;
      return true;
    }
    if (obj.videoDetails?.title) { obj.videoDetails.title = text; return true; }
    return false;
  }

  /** All thumbnail-array holders on a renderer object. */
  function thumbArraysOf(obj) {
    const arrays = [];
    if (Array.isArray(obj.thumbnail?.thumbnails)) arrays.push(obj.thumbnail.thumbnails);
    if (Array.isArray(obj.videoDetails?.thumbnail?.thumbnails)) {
      arrays.push(obj.videoDetails.thumbnail.thumbnails);
    }
    if (Array.isArray(obj.contentImage?.thumbnailViewModel?.image?.sources)) {
      arrays.push(obj.contentImage.thumbnailViewModel.image.sources);
    }
    return arrays;
  }

  function readThumbFromObj(obj) {
    if (!obj || typeof obj !== "object") return null;
    for (const arr of thumbArraysOf(obj)) {
      for (const t of arr) {
        if (t?.url && isValidThumb(t.url)) return t.url;
      }
    }
    return null;
  }

  /**
   * Rewrite each thumbnail entry to the pinned A/B variant while preserving that
   * entry's own resolution and refreshing volatile params. Reverting to the
   * original variant yields clean, param-less URLs that never expire.
   */
  function writeThumbToObj(obj, pinnedTh) {
    if (!obj || typeof obj !== "object" || !isValidThumb(pinnedTh)) return false;
    const pv = parseThumb(pinnedTh);
    let modified = false;

    for (const arr of thumbArraysOf(obj)) {
      for (const t of arr) {
        if (!t || typeof t.url !== "string") continue;
        const pe = parseThumb(t.url);
        if (!pe) {
          if (t.url !== pinnedTh) { t.url = pinnedTh; modified = true; }
          continue;
        }
        if (!pv) continue;
        if (pe.variant === pv.variant) continue; // already the pinned variant
        const next = pv.variant === ""
          ? buildBaseThumb(pe.id, pe.res, pe.webp) // original: robust param-less
          : pinnedTh;                              // custom: reuse stored URL
        if (t.url !== next) { t.url = next; modified = true; }
      }
    }
    return modified;
  }

  /* --------------------------------------------------------------- *
   * Video-id + source classification.
   * --------------------------------------------------------------- */

  function readVideoId(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (isValidId(obj.videoId)) return obj.videoId;
    if (isValidId(obj.videoDetails?.videoId)) return obj.videoDetails.videoId;
    // `contentId` is used by lockups; only accept it when it is an 11-char
    // video id (playlist/collection ids are longer and must be rejected).
    if (isValidId(obj.contentId)) return obj.contentId;
    return null;
  }

  // Renderer keys whose direct child is a canonical single video.
  const VIDEO_SOURCES = new Set([
    "videoRenderer", "compactVideoRenderer", "gridVideoRenderer",
    "movieRenderer", "playlistVideoRenderer", "channelVideoRenderer",
    "playlistPanelVideoRenderer", "videoPrimaryInfoRenderer", "videoDetails",
  ]);
  // Shorts renderers: pin titles but never thumbnails (vertical aspect would
  // leak onto the same video's horizontal cards).
  const SHORT_SOURCES = new Set(["reelItemRenderer", "shortsLockupViewModel"]);

  // Keys we descend into. `content` / `richItemRenderer` are structural wrappers.
  const UNWRAP_KEYS = new Set([
    "videoRenderer", "compactVideoRenderer", "gridVideoRenderer",
    "richItemRenderer", "reelItemRenderer", "movieRenderer",
    "playlistVideoRenderer", "channelVideoRenderer",
    "playlistPanelVideoRenderer", "lockupViewModel", "shortsLockupViewModel",
    "content",
  ]);

  function lockupKind(obj) {
    const ct = obj?.contentType;
    if (typeof ct === "string") {
      if (ct.includes("VIDEO")) return "video";
      return "skip"; // PLAYLIST / PODCAST / etc.
    }
    // No explicit type: treat as video only if it carries a videoId.
    return isValidId(obj?.contentId) || isValidId(obj?.videoId) ? "video" : "skip";
  }

  /**
   * Classify a node reached via `sourceKey`. Returns "video" (learn title +
   * thumb), "short" (learn title only), or "skip" (apply pins only, never learn).
   */
  function classify(sourceKey, obj) {
    if (VIDEO_SOURCES.has(sourceKey)) return "video";
    if (SHORT_SOURCES.has(sourceKey)) return "short";
    if (sourceKey === "lockupViewModel") return lockupKind(obj);
    return "skip";
  }

  /**
   * Collect video entries with a per-entry `kind` describing how canonical the
   * source is. `sourceKey` tracks the renderer that directly wrapped the node.
   */
  function collectVideoEntries(root, maxEntries) {
    const out = [];
    const max = maxEntries || MAX_ENTRIES;
    const visited = new WeakSet();

    function walk(val, sourceKey) {
      if (out.length >= max) return;
      if (!val || typeof val !== "object") return;
      if (visited.has(val)) return;
      visited.add(val);

      const vid = readVideoId(val);
      if (vid) {
        const kind = classify(sourceKey, val);
        const title = readTitleFromObj(val);
        const thumbUrl = kind === "video" ? readThumbFromObj(val) : null;
        if (title || thumbUrl) out.push({ videoId: vid, kind, title, thumbUrl, _obj: val });
      }

      for (const k of UNWRAP_KEYS) {
        const inner = val[k];
        if (inner && typeof inner === "object") walk(inner, k);
      }

      if (Array.isArray(val)) {
        for (const item of val) walk(item, sourceKey);
      } else {
        for (const key of Object.keys(val)) {
          if (UNWRAP_KEYS.has(key)) continue;
          const child = val[key];
          if (child && typeof child === "object") walk(child, key);
        }
      }
    }

    walk(root, "");
    return out;
  }

  /* --------------------------------------------------------------- *
   * Core: synchronous pin apply + learn.
   * --------------------------------------------------------------- */

  function mergeMirror(prev, patch) {
    const next = {
      t: prev && typeof prev.t === "string" ? prev.t : null,
      th: prev && typeof prev.th === "string" ? prev.th : null,
    };
    if (typeof patch.t === "string" && patch.t) next.t = patch.t;
    if (typeof patch.th === "string" && patch.th) next.th = patch.th;
    return next;
  }

  /**
   * Apply pins in place (when `applyInPlace`) and gather newly-seen values.
   * SYNCHRONOUS: reads the local mirror, never awaits.
   */
  function processEntries(entries, applyInPlace, applyTitles = true) {
    if (!enabled || entries.length === 0) return false;
    let modified = false;
    const learn = [];

    for (const e of entries) {
      if (!e.videoId) continue;
      const rec = cache.get(e.videoId);

      if (rec) {
        if (applyInPlace) {
          if (applyTitles && isValidTitle(rec.t) && writeTitleToObj(e._obj, rec.t)) {
            modified = true;
          }
          if (e.kind === "video" && isValidThumb(rec.th) && writeThumbToObj(e._obj, rec.th)) {
            modified = true;
          }
        }
        const patch = {};
        if (!isValidTitle(rec.t) && isValidTitle(e.title)) patch.t = normalizeTitle(e.title);
        if (e.kind === "video" && isValidThumb(e.thumbUrl)) {
          if (!isValidThumb(rec.th)) {
            patch.th = e.thumbUrl;
          } else {
            // Refresh volatile params when the same custom variant reappears.
            const pv = parseThumb(rec.th);
            const pe = parseThumb(e.thumbUrl);
            if (pv && pe && pv.variant && pv.variant === pe.variant && rec.th !== e.thumbUrl) {
              patch.th = e.thumbUrl;
            }
          }
        }
        if (patch.t || patch.th) learn.push({ id: e.videoId, ...patch });
        continue;
      }

      // First-seen (canonical sources only).
      if (e.kind === "skip") continue;
      const patch = { id: e.videoId };
      if (isValidTitle(e.title)) patch.t = normalizeTitle(e.title);
      if (e.kind === "video" && isValidThumb(e.thumbUrl)) patch.th = e.thumbUrl;
      if (patch.t || patch.th) learn.push(patch);
    }

    if (learn.length) {
      for (const p of learn) cache.set(p.id, mergeMirror(cache.get(p.id) || null, p));
      sendLearn(learn);
    }
    return modified;
  }

  /* --------------------------------------------------------------- *
   * MAIN <-> ISOLATED bridge.
   * --------------------------------------------------------------- */

  function post(type, payload) {
    window.postMessage({ source: PAGE_SOURCE, type, payload }, "*");
  }

  function sendLearn(entries) {
    post("LEARN", { entries });
  }

  function installBridgeListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== CONTENT_SOURCE) return;

      if (msg.type === "SET_CACHE") {
        const p = msg.payload || {};
        enabled = p.enabled !== false;
        // Merge (don't clear): this is a startup snapshot with no stale entries
        // to purge, and clearing would drop pins the MAIN world already learned
        // optimistically before the snapshot arrived.
        if (Array.isArray(p.entries)) {
          for (const [id, rec] of p.entries) {
            if (id && rec && (rec.t || rec.th)) cache.set(id, { t: rec.t || null, th: rec.th || null });
          }
        }
        cacheReady = true;
        return;
      }

      if (msg.type === "PATCH_CACHE") {
        const p = msg.payload || {};
        if (typeof p.enabled === "boolean") enabled = p.enabled;
        if (Array.isArray(p.records)) {
          for (const [id, rec] of p.records) {
            if (!id) continue;
            if (rec && (rec.t || rec.th)) cache.set(id, { t: rec.t || null, th: rec.th || null });
            else cache.delete(id);
          }
        }
        return;
      }
    });
  }

  /* --------------------------------------------------------------- *
   * Interception traps.
   * --------------------------------------------------------------- */

  function isYtApiUrl(str) {
    return typeof str === "string" && YT_API_RE.test(str);
  }

  function endpointMatches(url) {
    const m = url.match(YT_API_RE);
    return !!m && ENDPOINT_RE.test(m[1]);
  }

  /**
   * `player` is also the canonical-title fallback used by title-untranslator
   * extensions. Keep its title native so our fetch/XHR wrapper cannot feed a
   * stored A/B title back to those extensions. Other InnerTube surfaces are
   * presentation payloads and remain eligible for title pinning.
   */
  function shouldApplyTitlesForUrl(url) {
    const m = typeof url === "string" ? url.match(YT_API_RE) : null;
    return !m || m[1] !== "player";
  }

  function patchFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = async function ytPinFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      const response = await nativeFetch.call(this, input, init);

      if (!enabled || !isYtApiUrl(url) || !endpointMatches(url)) return response;

      try {
        const json = await response.clone().json();
        const entries = collectVideoEntries(json, MAX_ENTRIES);
        if (entries.length === 0) return response;
        const modified = processEntries(entries, true, shouldApplyTitlesForUrl(url));
        if (!modified) return response;
        return new Response(JSON.stringify(json), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch {
        return response;
      }
    };
  }

  function patchXHR() {
    const XHRProto = XMLHttpRequest.prototype;
    const nativeOpen = XHRProto.open;
    const nativeSend = XHRProto.send;
    const rtDesc = Object.getOwnPropertyDescriptor(XHRProto, "responseText");
    const respDesc = Object.getOwnPropertyDescriptor(XHRProto, "response");

    XHRProto.open = function ytPinOpen(method, url) {
      this.__ytPinUrl = typeof url === "string" ? url : url?.toString?.() || "";
      return nativeOpen.apply(this, arguments);
    };

    XHRProto.send = function ytPinSend() {
      const url = this.__ytPinUrl;
      if (!enabled || !isYtApiUrl(url) || !endpointMatches(url)) {
        return nativeSend.apply(this, arguments);
      }

      // Lazy getter overrides: whoever reads the response (in whatever listener
      // order) sees the rewritten body. Computed once, on first read after DONE.
      const compute = (xhr) => {
        if (xhr.__ytPinComputed) return;
        xhr.__ytPinComputed = true;
        try {
          const rt = xhr.responseType;
          if (rt === "json") {
            const obj = respDesc.get.call(xhr);
            const entries = collectVideoEntries(obj, MAX_ENTRIES);
            if (entries.length) {
              processEntries(entries, true, shouldApplyTitlesForUrl(url)); // mutates obj in place
            }
            return;
          }
          const raw = rtDesc.get.call(xhr);
          if (typeof raw !== "string" || !raw) return;
          const json = JSON.parse(raw);
          const entries = collectVideoEntries(json, MAX_ENTRIES);
          if (
            entries.length &&
            processEntries(entries, true, shouldApplyTitlesForUrl(url))
          ) {
            xhr.__ytPinText = JSON.stringify(json);
          }
        } catch {
          /* leave native response untouched */
        }
      };

      try {
        Object.defineProperty(this, "responseText", {
          configurable: true,
          get() {
            const raw = rtDesc.get.call(this);
            if (this.readyState !== 4) return raw;
            compute(this);
            return this.__ytPinText != null ? this.__ytPinText : raw;
          },
        });
        Object.defineProperty(this, "response", {
          configurable: true,
          get() {
            const raw = respDesc.get.call(this);
            if (this.readyState !== 4) return raw;
            compute(this);
            if (this.responseType === "json") return raw; // mutated in place
            if ((this.responseType === "" || this.responseType === "text") && this.__ytPinText != null) {
              return this.__ytPinText;
            }
            return raw;
          },
        });
      } catch {
        /* getter override unsupported: fall through to DOM reconciler */
      }

      return nativeSend.apply(this, arguments);
    };
  }

  function trapWindowProperty(name, applyTitles) {
    let stored;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          return stored;
        },
        set(v) {
          // Mutate SYNCHRONOUSLY before YouTube reads it back.
          if (enabled && v && typeof v === "object") {
            try {
              const entries = collectVideoEntries(v, MAX_ENTRIES);
              if (entries.length) processEntries(entries, true, applyTitles);
            } catch {
              /* ignore */
            }
          }
          stored = v;
        },
      });
    } catch {
      /* already defined by the page: DOM reconciler will cover it */
    }
  }

  function installInitialDataTraps() {
    if (!("ytInitialData" in window)) trapWindowProperty("ytInitialData", true);
    if (!("ytInitialPlayerResponse" in window)) {
      trapWindowProperty("ytInitialPlayerResponse", false);
    }
  }

  if (typeof window !== "undefined" && typeof XMLHttpRequest !== "undefined") {
    installBridgeListener();
    installInitialDataTraps();
    patchFetch();
    patchXHR();
    // Ask the ISOLATED world for the current cache snapshot. If ISOLATED is not
    // ready yet, it broadcasts SET_CACHE once it is; this covers both orders.
    post("HELLO");
  }

  // Expose pure helpers for unit tests (Node require); no-op in the browser.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      normalizeTitle, isValidTitle, isValidThumb, isValidId,
      parseThumb, buildBaseThumb, writeThumbToObj, readThumbFromObj,
      readTitleFromObj, writeTitleToObj,
      readVideoId, classify, collectVideoEntries, mergeMirror,
      shouldApplyTitlesForUrl,
    };
  }
})();
