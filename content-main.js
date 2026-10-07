/**
 * Runs in YouTube's MAIN world at document_start.
 *
 * Rewrites YouTube's own JSON (InnerTube fetch responses and the inline
 * ytInitialData / ytInitialPlayerResponse) so pinned titles and thumbnails are
 * rendered by YouTube itself: no flicker, no DOM fights, no recycling races.
 *
 * Hard rules — this script must never slow down or break YouTube:
 *   - Pins are looked up through a *synchronous* CustomEvent bridge to
 *     content.js (ISOLATED world). There is no async round trip, no timeout;
 *     if content.js does not answer, responses pass through untouched.
 *   - Responses keep native fetch timing: the Response is handed over at
 *     header time and streamed parts (get_watch) are forwarded as they arrive.
 *   - Only allowlisted endpoints and allowlisted renderer keys are touched;
 *     unchanged text is forwarded byte for byte.
 *   - Abort behaves as with a native fetch: the body errors with AbortError.
 *   - Any error, oversize body or blown time budget → original text.
 *   - Requests made by other extensions are never rewritten.
 */
(function ytPinMain() {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Pure helpers (exported for unit tests).
   * ------------------------------------------------------------------ */

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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

  /** Text of a string, `{runs}`, `{simpleText}` or attributed `{content}`. */
  function textOf(x) {
    if (typeof x === "string") return x;
    if (!x || typeof x !== "object") return null;
    if (Array.isArray(x.runs)) return x.runs.map((r) => (r && typeof r.text === "string" ? r.text : "")).join("");
    if (typeof x.simpleText === "string") return x.simpleText;
    if (typeof x.content === "string") return x.content;
    return null;
  }

  /** Replaces `old` with `next` inside an accessibility label string. */
  function replaceInLabel(holder, key, old, next) {
    const label = holder && holder[key];
    if (typeof label !== "string" || !old || !label.includes(old)) return;
    holder[key] = label.split(old).join(next);
  }

  /**
   * Writes `text` into holder[key], which is a plain string or one of the
   * text shapes read by textOf(). Returns true when the value changed.
   */
  function setTextAt(holder, key, text) {
    const cur = holder[key];
    if (typeof cur === "string") {
      if (normalizeTitle(cur) === text) return false;
      holder[key] = text;
      return true;
    }
    if (!cur || typeof cur !== "object") return false;
    const old = textOf(cur);
    if (old === null || normalizeTitle(old) === text) return false;
    if (Array.isArray(cur.runs)) {
      // Keep the first run's link/styling (e.g. YouTube Music's play endpoint).
      cur.runs = [{ ...cur.runs[0], text }];
    } else if (typeof cur.simpleText === "string") {
      cur.simpleText = text;
    } else {
      cur.content = text;
      // Offsets into the old text (hashtag links, bold ranges) no longer apply.
      delete cur.styleRuns;
      delete cur.commandRuns;
      delete cur.attachmentRuns;
      delete cur.decorationRuns;
    }
    replaceInLabel(cur.accessibility?.accessibilityData, "label", old, text);
    return true;
  }

  // vi, vi_webp, and vi_lc / vi_lc_webp (localized thumbnails, e.g. hq720_es.jpg).
  const THUMB_RE = /^https?:\/\/i\d?\.ytimg\.com\/vi(?:_[a-z]+)*\/[A-Za-z0-9_-]{11}\/([^/?#.]+)\.(?:jpg|webp)(?:[?#]|$)/i;
  const THUMB_SIZE_RE =
    /^(maxresdefault|sddefault|hqdefault|mqdefault|default|hq720|oardefault|sardefault|oar\d+|sar\d+|frame\d+|hq\d|mq\d|sd\d|maxres\d|\d)(.*)$/;

  /**
   * Classifies an i.ytimg.com video thumbnail URL.
   *   fam: "h" landscape, "v" vertical Shorts art, "f" raw video frame
   *   sig: variant signature — the file name without its size token, so
   *        hqdefault.jpg and hq720.jpg share "" while hqdefault_custom_2.jpg
   *        yields "_custom_2" and a localized hq720_es.jpg yields "_es".
   */
  function thumbInfo(url) {
    if (typeof url !== "string") return null;
    const m = THUMB_RE.exec(url);
    if (!m) return null;
    const s = THUMB_SIZE_RE.exec(m[1]);
    const size = s ? s[1] : m[1];
    const sig = s ? s[2] : m[1];
    const fam = /^frame/.test(size) ? "f" : /^(oar|sar)/.test(size) ? "v" : "h";
    return { fam, sig };
  }

  /** Largest recognised thumbnail in a `[{url,width,height}]` list. */
  function bestThumb(list) {
    if (!Array.isArray(list)) return null;
    let best = null;
    let bestArea = -1;
    for (const t of list) {
      const info = t && thumbInfo(t.url);
      if (!info) continue;
      const area = (Number(t.width) || 0) * (Number(t.height) || 0);
      if (area > bestArea) {
        best = { url: t.url, fam: info.fam, sig: info.sig };
        bestArea = area;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * Renderer allowlist.
   *
   * A handler receives the value stored under its key and returns:
   *   item  → extracted; the walker does not descend into it
   *   false → recognised but nothing to do; do not descend
   *   null  → not this shape; keep descending
   *
   * item = { id, learn, title: {holder,key}|null, a11y: {holder,key}|null,
   *          thumbs: [{url}]|null }
   * `learn` (true, or "thumb" for the thumbnail only) is only set where the id
   * is certain — in the same object, or the response's agreed context id for
   * the page's own title — so first-seen values never land on the wrong video.
   * Titles are learned from what YouTube *displays*: the player's
   * videoDetails carries the untranslated title, while lists, the watch h1 and
   * Shorts show YouTube's auto-translation, so videoDetails only teaches the
   * thumbnail.
   * ------------------------------------------------------------------ */

  function makeItem(id, learn, titleHolder, titleKey, thumbs, a11y) {
    if (!isVideoId(id)) return false;
    const title = titleHolder && textOf(titleHolder[titleKey]) !== null ? { holder: titleHolder, key: titleKey } : null;
    const list = Array.isArray(thumbs) && thumbs.length ? thumbs : null;
    if (!title && !list) return false;
    return { id, learn, title, a11y: a11y || null, thumbs: list };
  }

  /** Classic renderers: { videoId, title|headline, thumbnail: { thumbnails } }. */
  function classic(titleKey) {
    return (o) => makeItem(o.videoId, true, o, titleKey, o.thumbnail?.thumbnails);
  }

  function contextOnly(titleKey) {
    return (o, ctxId) => (ctxId ? makeItem(ctxId, false, o, titleKey, null) : null);
  }

  const HANDLERS = new Map([
    ["videoRenderer", classic("title")],
    ["compactVideoRenderer", classic("title")],
    ["gridVideoRenderer", classic("title")],
    ["playlistVideoRenderer", classic("title")],
    ["playlistPanelVideoRenderer", classic("title")],
    ["endScreenVideoRenderer", classic("title")],
    ["channelVideoPlayerRenderer", classic("title")],
    ["videoWithContextRenderer", classic("headline")],
    ["reelItemRenderer", classic("headline")],
    [
      "lockupViewModel",
      (o) => {
        if (o.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO") return false;
        return makeItem(
          o.contentId,
          true,
          o.metadata?.lockupMetadataViewModel,
          "title",
          o.contentImage?.thumbnailViewModel?.image?.sources,
          o.rendererContext?.accessibilityContext ? { holder: o.rendererContext.accessibilityContext, key: "label" } : null
        );
      },
    ],
    [
      "shortsLockupViewModel",
      (o) => {
        const id =
          o.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId ||
          (typeof o.entityId === "string" ? o.entityId.replace(/^shorts-shelf-item-/, "") : null);
        return makeItem(
          id,
          true,
          o.overlayMetadata,
          "primaryText",
          o.thumbnailViewModel?.thumbnailViewModel?.image?.sources,
          { holder: o, key: "accessibilityText" }
        );
      },
    ],
    [
      // The player response's own metadata. Other objects are also called
      // `videoDetails` (e.g. playerOverlayRenderer.videoDetails) — require an id.
      "videoDetails",
      (o) =>
        isVideoId(o.videoId) && typeof o.title === "string"
          ? makeItem(o.videoId, "thumb", o, "title", o.thumbnail?.thumbnails)
          : null,
    ],
    [
      "videoPrimaryInfoRenderer",
      (o, ctxId) => {
        const own = o.updatedMetadataEndpoint?.updatedMetadataEndpoint?.videoId;
        if (own && ctxId && own !== ctxId) return false;
        return makeItem(own || ctxId, Boolean(own), o, "title", null);
      },
    ],
    [
      // Its `title` is the "Up next" label — only `videoTitle` is the video's.
      "playerOverlayAutoplayRenderer",
      (o) => makeItem(o.videoId, false, o, "videoTitle", o.background?.thumbnails),
    ],
    [
      "endscreenElementRenderer",
      (o) =>
        o.style === "VIDEO" ? makeItem(o.endpoint?.watchEndpoint?.videoId, false, o, "title", o.image?.thumbnails) : false,
    ],
    ["playerOverlayVideoDetailsRenderer", contextOnly("title")],
    ["videoDescriptionHeaderRenderer", contextOnly("title")],
    // The current Short's displayed title (one per reel response).
    ["shortsVideoTitleViewModel", (o, ctxId) => (ctxId ? makeItem(ctxId, true, o, "text", null) : null)],
    ["updateTitleAction", contextOnly("title")],
    [
      "playerMicroformatRenderer",
      (o, ctxId) => (ctxId ? makeItem(ctxId, false, o, "title", o.thumbnail?.thumbnails) : null),
    ],
    ["microformatDataRenderer", contextOnly("title")],
    // YouTube Music rows. Only song/video rows carry playlistItemData.videoId
    // (album and playlist rows do not), and two-row items that open a
    // playlist/album link their title to a browse page.
    [
      "musicResponsiveListItemRenderer",
      (o) =>
        makeItem(
          o.playlistItemData?.videoId,
          true,
          o.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer,
          "text",
          o.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails
        ),
    ],
    [
      "musicTwoRowItemRenderer",
      (o) =>
        o.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint
          ? false
          : makeItem(
              o.navigationEndpoint?.watchEndpoint?.videoId,
              true,
              o,
              "title",
              o.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails
            ),
    ],
    // Never touched: chapter titles and Shorts' first-frame placeholders.
    ["macroMarkersListItemRenderer", () => false],
    ["reelWatchEndpoint", () => false],
  ]);

  /** Subtrees that never contain anything we handle. */
  const SKIP_KEYS = new Set([
    "frameworkUpdates", "responseContext", "streamingData", "playerConfig", "storyboards",
    "captions", "adPlacements", "adSlots", "playerAds", "playbackTracking", "heartbeatParams",
    "attestation", "topbar", "desktopTopbar", "loggingDirectives", "commandMetadata",
    "menu", "menuOnTap", "navigationEndpoint", "onTap", "onLongPress", "serviceEndpoint",
    "thumbnailOverlays", "richThumbnail", "inlinePlaybackEndpoint", "channelThumbnailSupportedRenderers",
  ]);

  /**
   * Walks a response in document order and returns the allowlisted items, or
   * null when the time budget is exceeded.
   */
  function collectItems(root, ctxId, budgetMs = Infinity, now = () => Date.now()) {
    const items = [];
    if (!root || typeof root !== "object") return items;
    const t0 = now();
    const stack = [root];
    const children = [];
    let visited = 0;
    while (stack.length) {
      const v = stack.pop();
      if ((++visited & 1023) === 0 && now() - t0 > budgetMs) return null;
      children.length = 0;
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c === "object") children.push(c);
      } else {
        for (const k in v) {
          const c = v[k];
          if (!c || typeof c !== "object") continue;
          const handler = HANDLERS.get(k);
          if (handler) {
            const item = handler(c, ctxId);
            if (item) items.push(item);
            if (item !== null) continue;
          }
          if (!SKIP_KEYS.has(k)) children.push(c);
        }
      }
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
    return items;
  }

  /** Bridge payload: native values only for items we may learn from. */
  function toQueryItems(items) {
    return items.map((it) => {
      const q = { id: it.id };
      if (!it.learn) return q;
      q.learn = true;
      const t = it.title && it.learn !== "thumb" ? textOf(it.title.holder[it.title.key]) : null;
      if (isValidTitle(t)) q.t = normalizeTitle(t);
      const best = bestThumb(it.thumbs);
      // Raw frames and live/premiere art are not stable thumbnails.
      if (best && best.fam !== "f" && !/live/i.test(best.sig)) {
        q.th = best.url;
        q.fam = best.fam;
      }
      return q;
    });
  }

  /**
   * Writes pins into the collected items. `pins` maps id → { t, th, tv }.
   * Only values that differ from what YouTube sent are touched.
   * `onThumbSwap(id, fam, pinnedUrl, nativeUrl)` is told about each
   * replaced thumbnail. Returns the number of changed fields.
   */
  function applyPins(items, pins, onThumbSwap) {
    let changed = 0;
    for (const it of items) {
      const pin = pins && pins[it.id];
      if (!pin) continue;
      if (it.title && isValidTitle(pin.t)) {
        const pinned = normalizeTitle(pin.t);
        const old = textOf(it.title.holder[it.title.key]);
        if (setTextAt(it.title.holder, it.title.key, pinned)) {
          changed++;
          if (it.a11y) replaceInLabel(it.a11y.holder, it.a11y.key, old, pinned);
        }
      }
      if (it.thumbs) {
        const native = bestThumb(it.thumbs);
        if (native && native.fam !== "f") {
          const pinnedUrl = native.fam === "v" ? pin.tv : pin.th;
          const pinned = thumbInfo(pinnedUrl);
          if (pinned && pinned.fam === native.fam && pinned.sig !== native.sig) {
            for (const t of it.thumbs) if (t && typeof t.url === "string") t.url = pinnedUrl;
            onThumbSwap?.(it.id, native.fam, pinnedUrl, native.url);
            changed++;
          }
        }
      }
    }
    return changed;
  }

  /* ------------------------------------------------------------------ *
   * Request / context helpers.
   * ------------------------------------------------------------------ */

  const ENDPOINTS = new Set([
    "browse", "next", "search", "player", "get_watch", "updated_metadata",
    "reel/reel_item_watch", "reel/reel_watch_sequence", "music/get_queue",
  ]);

  /** InnerTube endpoint name for allowlisted URLs, else null. */
  function matchEndpoint(url) {
    if (typeof url !== "string") return null;
    const i = url.indexOf("/youtubei/v1/");
    if (i < 0) return null;
    let ep = url.slice(i + 13);
    const q = ep.search(/[?#]/);
    if (q >= 0) ep = ep.slice(0, q);
    return ENDPOINTS.has(ep) ? ep : null;
  }

  function requestVideoId(body) {
    if (typeof body !== "string" || body.length > 200_000 || !body.includes("ideoId")) return null;
    try {
      const b = JSON.parse(body);
      const id = b?.videoId ?? b?.playerRequest?.videoId ?? b?.watchNextRequest?.videoId;
      return isVideoId(id) ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * The video a response describes. `get_watch` answers with an array of
   * parts ([{playerResponse}, {watchNextResponse}]); they must all agree.
   */
  function responseVideoId(json) {
    if (Array.isArray(json)) {
      const ids = new Set(json.map(responseVideoId).filter(Boolean));
      return ids.size === 1 ? [...ids][0] : null;
    }
    const c = [
      json?.currentVideoEndpoint?.watchEndpoint?.videoId,
      json?.currentVideoEndpoint?.reelWatchEndpoint?.videoId,
      json?.videoDetails?.videoId,
      json?.playerResponse?.videoDetails?.videoId,
      json?.watchNextResponse?.currentVideoEndpoint?.watchEndpoint?.videoId,
    ];
    return c.find(isVideoId) || null;
  }

  function locationVideoId(href) {
    try {
      const u = new URL(href);
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return isVideoId(id) ? id : null;
      }
      const v = u.searchParams.get("v");
      return u.pathname === "/watch" && isVideoId(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** The video a response is "about"; null when sources disagree. */
  function contextVideoId(requestId, json) {
    const fromResponse = responseVideoId(json);
    if (requestId && fromResponse && requestId !== fromResponse) return null;
    return requestId || fromResponse;
  }

  /* ------------------------------------------------------------------ *
   * Response rewriting.
   * ------------------------------------------------------------------ */

  const MAX_BODY_CHARS = 8_000_000;

  function abortError(signal) {
    return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  function rebuildResponse(res, body) {
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const out = new Response(body, { status: res.status, statusText: res.statusText, headers });
    for (const k of ["url", "redirected"]) {
      try {
        Object.defineProperty(out, k, { value: res[k] });
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  /**
   * Incremental JSON patcher. push() takes decoded text and returns the text
   * that may be forwarded right away; end() returns the rest.
   *
   * YouTube streams `get_watch` as a top-level array ([{playerResponse},
   * {watchNextResponse}]) and starts the player as soon as the first part has
   * arrived, so array elements are forwarded one by one, the moment each is
   * complete. Any other document is forwarded whole at the end (YouTube needs
   * it whole to parse it anyway). `processElement(text)` returns replacement
   * text, or null to forward the original text untouched.
   */
  function createStreamPatcher(processElement) {
    let mode = null; // "array" | "whole" | "raw"
    let buf = "";
    let scan = 0;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let elemStart = -1;

    function push(text) {
      buf += text;
      if (mode === null) {
        const first = /\S/.exec(buf);
        if (!first) return "";
        const c = buf[first.index];
        mode = c === "[" ? "array" : c === "{" ? "whole" : "raw";
      }
      if (mode === "whole") return "";
      let out = "";
      if (mode === "array") {
        for (; scan < buf.length; scan++) {
          const c = buf.charCodeAt(scan);
          if (inStr) {
            if (esc) esc = false;
            else if (c === 92) esc = true; // backslash
            else if (c === 34) inStr = false; // quote
          } else if (c === 34) {
            inStr = true;
          } else if (c === 123 || c === 91) {
            // { or [
            if (depth === 1 && c === 123) elemStart = scan;
            depth++;
          } else if (c === 125 || c === 93) {
            // } or ]
            depth--;
            if (depth === 1 && c === 125 && elemStart >= 0) {
              const elem = buf.slice(elemStart, scan + 1);
              out += buf.slice(0, elemStart) + (processElement(elem) ?? elem);
              buf = buf.slice(scan + 1);
              scan = -1;
              elemStart = -1;
            }
          }
        }
      }
      // Forward everything that is not part of an unfinished element.
      const keep = mode === "array" && elemStart >= 0 ? elemStart : buf.length;
      out += buf.slice(0, keep);
      buf = buf.slice(keep);
      scan -= keep;
      if (elemStart >= 0) elemStart = 0;
      return out;
    }

    function end() {
      const rest = buf;
      buf = "";
      return mode === "whole" ? processElement(rest) ?? rest : rest;
    }

    return { push, end };
  }

  /**
   * Wraps a JSON InnerTube response so allowlisted content is patched while
   * it streams through. Like a native fetch, the Response is available as
   * soon as headers arrive; an abort errors the body; anything unexpected
   * forwards the original text untouched.
   *
   * process(json, ctxId, endpoint) mutates `json` and returns the number of
   * changes. waitUntilReady() (optional) is awaited before the first chunk.
   */
  function transformResponse(res, { endpoint, requestId, signal, process, waitUntilReady, onError }) {
    if (!res.ok || res.status !== 200 || !res.body) return res;
    if (!(res.headers.get("content-type") || "").includes("json")) return res;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const patcher = createStreamPatcher((text) => {
      if (text.length > MAX_BODY_CHARS) return null;
      try {
        const json = JSON.parse(text);
        return process(json, contextVideoId(requestId, json), endpoint) ? JSON.stringify(json) : null;
      } catch (err) {
        onError?.(err);
        return null;
      }
    });
    let waited = !waitUntilReady;

    const body = new ReadableStream({
      async pull(controller) {
        try {
          if (!waited) {
            waited = true;
            await waitUntilReady();
          }
          // Loop until something is enqueued: a pull that resolves without
          // enqueueing is not called again and would stall the reader.
          for (;;) {
            const { done, value } = await reader.read();
            if (signal?.aborted) throw abortError(signal);
            const out = done ? patcher.push(decoder.decode()) + patcher.end() : patcher.push(decoder.decode(value, { stream: true }));
            if (out) controller.enqueue(encoder.encode(out));
            if (done) {
              controller.close();
              return;
            }
            if (out) return;
          }
        } catch (err) {
          controller.error(signal?.aborted ? abortError(signal) : err);
          reader.cancel(err).catch(() => {});
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return rebuildResponse(res, body);
  }

  const core = {
    isVideoId, normalizeTitle, isValidTitle, textOf, setTextAt, thumbInfo, bestThumb,
    collectItems, toQueryItems, applyPins, matchEndpoint, requestVideoId,
    responseVideoId, locationVideoId, contextVideoId, createStreamPatcher, transformResponse, HANDLERS,
  };

  if (typeof window === "undefined") {
    if (typeof module === "object" && module.exports) module.exports = core;
    return;
  }

  /* ------------------------------------------------------------------ *
   * Runtime (browser only).
   * ------------------------------------------------------------------ */

  const EVT_QUERY = "ytpin:q";
  const EVT_ANSWER = "ytpin:a";
  const EVT_STATE = "ytpin:state";
  /** Startup only: how long a response may wait for the pin store to load. */
  const READY_WAIT_MS = 300;
  const WALK_BUDGET_MS = 50;
  /** YouTube Music shows song titles for the same video ids — separate pins. */
  const NAMESPACE = location.hostname === "music.youtube.com" ? "m" : "";

  let DEBUG = false;
  try {
    DEBUG = localStorage.getItem("ytpin:debug") === "1";
  } catch {
    /* storage blocked */
  }
  function log(...parts) {
    if (!DEBUG) return;
    const text = parts.map((p) => (typeof p === "string" || p instanceof Error ? String(p) : JSON.stringify(p)));
    console.debug(`[ytpin] ${text.join(" ")}`);
  }

  let ready = false;
  let enabled = true;
  let answer = null;
  let readyWaiters = [];

  // Other extensions (e.g. title un-translators) call InnerTube themselves to
  // read the *original* data; their requests are passed through untouched.
  // Detected by an extension URL other than ours on the calling stack. Chrome
  // shows this script as chrome-extension://<our id>/…; Firefox shows MAIN-world
  // content scripts as "<anonymous code>", so there any extension URL (e.g. a
  // <script src="moz-extension://…"> injected by another add-on) is foreign.
  const EXTENSION_URL_RE = /(?:moz|chrome|safari-web)-extension:\/\/[^/\s)]+/g;
  const OWN_EXTENSION = (() => {
    try {
      return new Error().stack.match(EXTENSION_URL_RE)?.[0] ?? null;
    } catch {
      return null;
    }
  })();

  function calledByAnotherExtension() {
    const stack = new Error().stack || "";
    for (const url of stack.match(EXTENSION_URL_RE) || []) if (url !== OWN_EXTENSION) return true;
    return false;
  }

  function setState(s) {
    if (!s || typeof s !== "object") return;
    enabled = s.enabled !== false;
    if (s.ready && !ready) {
      ready = true;
      log("pin store ready", { atMs: Math.round(performance.now()) });
      for (const wake of readyWaiters.splice(0)) wake();
      flushPendingInitial();
    }
  }

  document.addEventListener(EVT_ANSWER, (e) => {
    answer = e.detail;
  });
  document.addEventListener(EVT_STATE, (e) => {
    try {
      setState(JSON.parse(e.detail));
    } catch {
      /* ignore */
    }
  });

  /** Synchronous call into content.js; null when it is not listening. */
  function query(payload) {
    answer = null;
    document.dispatchEvent(new CustomEvent(EVT_QUERY, { detail: JSON.stringify(payload) }));
    const raw = answer;
    answer = null;
    if (typeof raw !== "string") return null;
    try {
      const res = JSON.parse(raw);
      setState(res);
      return res;
    } catch {
      return null;
    }
  }

  function waitReady(ms) {
    if (ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Collects, asks for pins (learning first-seen values), applies. */
  function processJson(json, ctxId, label) {
    const t0 = performance.now();
    const items = collectItems(json, ctxId, WALK_BUDGET_MS, () => performance.now());
    if (!items) {
      log(label, "walk budget exceeded — left untouched");
      return 0;
    }
    if (!items.length) return 0;
    const res = query({ ns: NAMESPACE, items: toQueryItems(items) });
    if (!res || !res.ready || res.enabled === false) return 0;
    const changed = applyPins(items, res.pins, rememberThumbSwap);
    log(label, { items: items.length, changed, ms: +(performance.now() - t0).toFixed(1) });
    return changed;
  }

  // --- thumbnail self-healing ------------------------------------------
  //
  // A pinned A/B variant can disappear from the CDN once YouTube's test
  // ends. i.ytimg.com then answers 404 *with* a 120x90 grey placeholder that
  // browsers happily display, so a pinned image that errors or loads as that
  // placeholder is switched to YouTube's own thumbnail and the thumbnail pin
  // is forgotten. (Only default.jpg is legitimately 120x90, and the pinned URL
  // is always the largest size seen.)

  const MAX_SWAPS = 2000;
  const thumbSwaps = new Map(); // pinned URL → { id, fam, native }

  function rememberThumbSwap(id, fam, pinnedUrl, native) {
    thumbSwaps.delete(pinnedUrl);
    thumbSwaps.set(pinnedUrl, { id, fam, native });
    if (thumbSwaps.size > MAX_SWAPS) thumbSwaps.delete(thumbSwaps.keys().next().value);
  }

  function checkPinnedImage(e) {
    if (!thumbSwaps.size) return;
    const img = e.composedPath?.()[0] || e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const url = thumbSwaps.has(img.currentSrc) ? img.currentSrc : img.src;
    const swap = thumbSwaps.get(url);
    if (!swap) return;
    const placeholder = img.naturalWidth === 120 && img.naturalHeight === 90 && !/\/default[._]/.test(url);
    if (e.type === "load" && !placeholder) return;
    img.src = swap.native;
    query({ ns: NAMESPACE, forget: [{ id: swap.id, fam: swap.fam }] });
    log("pinned thumbnail is gone from the CDN; reverted", swap.id);
  }
  document.addEventListener("load", checkPinnedImage, true);
  document.addEventListener("error", checkPinnedImage, true);

  // --- fetch -----------------------------------------------------------

  /** Set when the pin store did not answer in time; stop waiting for it. */
  let gaveUpWaiting = false;

  async function waitForStore() {
    if (ready || gaveUpWaiting) return;
    const t0 = performance.now();
    await waitReady(READY_WAIT_MS);
    if (!ready) gaveUpWaiting = true;
    log("waited for the pin store", { ms: Math.round(performance.now() - t0), ready });
  }

  function patchFetch() {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch !== "function") return;
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const pending = Reflect.apply(target, thisArg, args);
        if (!enabled || (!ready && gaveUpWaiting)) return pending;
        const [input, init] = args;
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        const endpoint = matchEndpoint(url);
        if (!endpoint || calledByAnotherExtension()) return pending;
        const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        const requestId = requestVideoId(init?.body);
        return pending.then((res) =>
          transformResponse(res, {
            endpoint,
            requestId,
            signal,
            process: processJson,
            waitUntilReady: waitForStore,
            onError: (err) => log(endpoint, "left untouched:", err),
          })
        );
      },
    });
  }

  // --- inline initial data -------------------------------------------

  /** Initial-data objects seen before the pin store was ready. */
  const pendingInitial = [];

  function processInitial(name, obj) {
    if (!enabled || !obj || typeof obj !== "object") return;
    if (!ready) {
      pendingInitial.push({ name, obj, href: location.href });
      return;
    }
    processJson(obj, responseVideoId(obj) || locationVideoId(location.href), name);
  }

  function flushPendingInitial() {
    let changed = 0;
    for (const { name, obj, href } of pendingInitial.splice(0)) {
      if (enabled) changed += processJson(obj, responseVideoId(obj) || locationVideoId(href), `${name} (late)`);
    }
    // YouTube may already have rendered the unpatched data.
    if (changed) scheduleDomNet();
  }

  function trapInitial(name) {
    const desc = Object.getOwnPropertyDescriptor(window, name);
    if (desc && !desc.configurable) return;
    let value = desc && "value" in desc ? desc.value : undefined;
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get() {
        return value;
      },
      set(v) {
        value = v;
        processInitial(name, v);
      },
    });
    if (value !== undefined) processInitial(name, value);
  }

  // --- DOM safety net ------------------------------------------------
  //
  // Only for the main watch title and the current Short's title, and only
  // when the JSON could not be patched in time (late initial data). Writes
  // only when the element belongs to the video the player is playing.

  const PIN_TEXT_SKIP_SEL = "script, style, textarea, noscript";

  function collectTextNodes(root, max) {
    const out = [];
    (function walk(node) {
      if (out.length >= max) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (normalizeTitle(node.nodeValue)) out.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(PIN_TEXT_SKIP_SEL)) return;
      for (const c of node.childNodes) walk(c);
      if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c);
    })(root);
    return out;
  }

  /** Mutates text nodes in place so the component's structure survives. */
  function setElementText(el, text) {
    const nodes = collectTextNodes(el, 48);
    if (!nodes.length) {
      el.textContent = text;
      return;
    }
    nodes[0].nodeValue = text;
    for (let i = 1; i < nodes.length; i++) nodes[i].nodeValue = "";
  }

  function playerVideoId(selector) {
    try {
      return document.querySelector(selector)?.getVideoData?.()?.video_id || null;
    } catch {
      return null;
    }
  }

  function currentTitleElement() {
    const id = locationVideoId(location.href);
    if (!id) return null;
    if (location.pathname === "/watch") {
      const playing = playerVideoId("#movie_player");
      if (playing && playing !== id) return null;
      const meta = document.querySelector(`ytd-watch-metadata[video-id="${id}"]`);
      const el = meta?.querySelector("h1 yt-formatted-string") || meta?.querySelector("h1");
      return el ? { id, el } : null;
    }
    const playing = playerVideoId("#shorts-player");
    if (playing !== id) return null;
    const reels = document.querySelectorAll("ytd-shorts ytd-reel-video-renderer");
    const active = [...reels].find((r) => r.hasAttribute("is-active")) || (reels.length === 1 ? reels[0] : null);
    const el = active?.querySelector("yt-shorts-video-title-view-model h1");
    return el ? { id, el } : null;
  }

  function runDomNet() {
    if (!ready || !enabled) return;
    const target = currentTitleElement();
    if (!target) return;
    const res = query({ ns: NAMESPACE, items: [{ id: target.id }] });
    const pinned = res?.pins?.[target.id]?.t;
    if (!isValidTitle(pinned)) return;
    const want = normalizeTitle(pinned);
    if (normalizeTitle(target.el.textContent) === want) return;
    setElementText(target.el, want);
    log("dom net: pinned title for", target.id);
  }

  let domNetTimers = [];
  function scheduleDomNet() {
    for (const t of domNetTimers) clearTimeout(t);
    domNetTimers = [setTimeout(runDomNet, 50), setTimeout(runDomNet, 600)];
  }

  // --- boot ------------------------------------------------------------

  log("boot", { namespace: NAMESPACE || "www", extension: OWN_EXTENSION });

  patchFetch();
  trapInitial("ytInitialPlayerResponse");
  trapInitial("ytInitialData");
  for (const evt of ["yt-navigate-finish", "yt-page-data-updated"]) {
    document.addEventListener(evt, scheduleDomNet);
  }
  // content.js may already be running (load order between worlds is not
  // guaranteed); otherwise it announces itself with EVT_STATE.
  query({ ns: NAMESPACE, items: [] });
})();
