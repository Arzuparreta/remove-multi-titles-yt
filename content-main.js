/**
 * Runs in YouTube's MAIN world.
 *
 * This script can patch page-owned APIs (`fetch`, XHR, `ytInitialData`) that
 * an isolated content script cannot reach. It has no extension APIs, so it
 * asks `content.js` to decide what is already pinned and what should be
 * learned.
 */

(() => {
  const PAGE_SOURCE = "yt-pin-main";
  const CONTENT_SOURCE = "yt-pin-content";
  const YT_ID_RE = /[a-zA-Z0-9_-]{11}/;
  const YT_API_RE = /\/youtubei\/v1\/([^?]+)/;
  const REQUEST_TIMEOUT_MS = 2500;

  let requestSeq = 1;
  let enabled = true;
  const pendingRequests = new Map();

  function normalizeTitle(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isValidTitle(s) {
    const t = normalizeTitle(s);
    if (!t || t === "undefined") return false;
    if (/^\d{1,3}:\d{2}:\d{2}$/.test(t)) return false;
    if (/^\d{1,2}:\d{2}$/.test(t)) return false;
    return true;
  }

  function isValidThumb(s) {
    return typeof s === "string" && s.includes("ytimg.com");
  }

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

  function collectVideoEntries(root, maxEntries) {
    const out = [];
    const max = maxEntries || 2000;
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
        if (title || thumbUrl) out.push({ videoId: vid, title, thumbUrl, _obj: val });
      }

      for (const k of UNWRAP_KEYS) {
        const inner = val[k];
        if (inner && typeof inner === "object") walk(inner);
      }

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

  function isYtApiUrl(str) {
    return typeof str === "string" && YT_API_RE.test(str);
  }

  function getYtEndpoint(str) {
    const m = str.match(YT_API_RE);
    return m ? m[1] : "";
  }

  function serializeEntries(entries) {
    return entries.map((e, i) => ({
      i,
      videoId: e.videoId,
      title: isValidTitle(e.title) ? normalizeTitle(e.title) : null,
      thumbUrl: isValidThumb(e.thumbUrl) ? e.thumbUrl : null,
    }));
  }

  function requestContent(type, payload) {
    const requestId = requestSeq++;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, timeout });
      window.postMessage({ source: PAGE_SOURCE, type, requestId, payload }, "*");
    });
  }

  async function processEntries(entries, canModify) {
    if (!enabled || entries.length === 0) return false;

    const response = await requestContent("PROCESS_ENTRIES", {
      canModify,
      entries: serializeEntries(entries),
    });

    if (!response || response.enabled === false) {
      enabled = response ? response.enabled !== false : enabled;
      return false;
    }

    let modified = false;
    const patches = Array.isArray(response.patches) ? response.patches : [];
    for (const p of patches) {
      const entry = entries[p.i];
      if (!entry) continue;
      if (canModify && isValidTitle(p.t) && writeTitleToObj(entry._obj, p.t)) {
        modified = true;
      }
      if (canModify && isValidThumb(p.th) && writeThumbToObj(entry._obj, p.th)) {
        modified = true;
      }
    }
    return modified;
  }

  function installBridgeListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || msg.source !== CONTENT_SOURCE) return;
      if (msg.type === "READY") {
        enabled = msg.payload?.enabled !== false;
        return;
      }
      if (msg.type !== "RESPONSE") return;
      const pending = pendingRequests.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(msg.requestId);
      pending.resolve(msg.payload || null);
    });

    window.postMessage({ source: PAGE_SOURCE, type: "READY" }, "*");
  }

  function patchFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;

    window.fetch = async function ytPinFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url || "";
      const response = await nativeFetch.call(this, input, init);

      if (!isYtApiUrl(url)) return response;
      const ep = getYtEndpoint(url);
      if (!/^(player|next|browse|search|reel)/.test(ep)) return response;

      try {
        const json = await response.clone().json();
        const entries = collectVideoEntries(json, 2000);
        if (entries.length === 0) return response;

        const modified = await processEntries(entries, true);
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

    XHRProto.open = function ytPinOpen(method, url) {
      this.__ytPinUrl = typeof url === "string" ? url : url?.toString?.() || "";
      return nativeOpen.apply(this, arguments);
    };

    XHRProto.send = function ytPinSend() {
      const url = this.__ytPinUrl;
      if (isYtApiUrl(url)) {
        const ep = getYtEndpoint(url);
        if (/^(player|next|browse|search|reel)/.test(ep)) {
          this.addEventListener("readystatechange", function handler() {
            if (this.readyState !== XMLHttpRequest.DONE || this.status !== 200) return;
            try {
              const json = JSON.parse(this.responseText);
              const entries = collectVideoEntries(json, 2000);
              if (entries.length > 0) void processEntries(entries, false);
            } catch {
              /* ignore */
            }
          });
        }
      }
      return nativeSend.apply(this, arguments);
    };
  }

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
          const entries = collectVideoEntries(v, 2000);
          if (entries.length > 0) void processEntries(entries, true);
        }
      },
    });
  }

  function installInitialDataTraps() {
    if (!("ytInitialData" in window)) trapWindowProperty("ytInitialData");
    if (!("ytInitialPlayerResponse" in window)) trapWindowProperty("ytInitialPlayerResponse");
  }

  installBridgeListener();
  installInitialDataTraps();
  patchFetch();
  patchXHR();
})();
