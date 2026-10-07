/**
 * Unit tests for the MAIN-world core in content-main.js, mostly against real
 * YouTube JSON captured by `node scripts/capture-fixtures.mjs`.
 * Run with: npm run test:unit
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const core = require(path.resolve(__dirname, "..", "..", "content-main.js"));

const FIXTURES = path.resolve(__dirname, "..", "fixtures");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

/** All values stored under `key` anywhere in `obj`. */
function findAll(obj, key, out = []) {
  if (!obj || typeof obj !== "object") return out;
  for (const k of Object.keys(obj)) {
    if (k === key) out.push(obj[k]);
    findAll(obj[k], key, out);
  }
  return out;
}

const learnable = (json, ctx = core.responseVideoId(json)) => core.toQueryItems(core.collectItems(json, ctx));

test("matchEndpoint only accepts allowlisted InnerTube endpoints", () => {
  assert.equal(core.matchEndpoint("/youtubei/v1/next?prettyPrint=false"), "next");
  assert.equal(core.matchEndpoint("https://www.youtube.com/youtubei/v1/browse"), "browse");
  assert.equal(core.matchEndpoint("/youtubei/v1/reel/reel_item_watch?x=1"), "reel/reel_item_watch");
  assert.equal(core.matchEndpoint("/youtubei/v1/updated_metadata"), "updated_metadata");
  assert.equal(core.matchEndpoint("/youtubei/v1/player/heartbeat?alt=json"), null);
  assert.equal(core.matchEndpoint("/youtubei/v1/browse/edit_playlist"), null);
  assert.equal(core.matchEndpoint("/youtubei/v1/live_chat/get_live_chat"), null);
  assert.equal(core.matchEndpoint("https://example.com/next"), null);
  assert.equal(core.matchEndpoint(undefined), null);
});

test("video ids are anchored: playlist and mix ids are rejected", () => {
  assert.equal(core.isVideoId("dQw4w9WgXcQ"), true);
  assert.equal(core.isVideoId("RDdQw4w9WgXcQ"), false);
  assert.equal(core.isVideoId("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"), false);
});

test("context id comes from the request body and response, and is dropped when they disagree", () => {
  assert.equal(core.requestVideoId(JSON.stringify({ videoId: "dQw4w9WgXcQ" })), "dQw4w9WgXcQ");
  assert.equal(core.requestVideoId(JSON.stringify({ playerRequest: { videoId: "ab8KjD1hDak" } })), "ab8KjD1hDak");
  assert.equal(core.requestVideoId(JSON.stringify({ continuation: "x" })), null);
  assert.equal(core.requestVideoId("not json videoId"), null);

  const json = { currentVideoEndpoint: { watchEndpoint: { videoId: "dQw4w9WgXcQ" } } };
  assert.equal(core.contextVideoId(null, json), "dQw4w9WgXcQ");
  assert.equal(core.contextVideoId("dQw4w9WgXcQ", json), "dQw4w9WgXcQ");
  assert.equal(core.contextVideoId("ab8KjD1hDak", json), null);

  assert.equal(core.locationVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"), "dQw4w9WgXcQ");
  assert.equal(core.locationVideoId("https://www.youtube.com/shorts/ab8KjD1hDak"), "ab8KjD1hDak");
  assert.equal(core.locationVideoId("https://www.youtube.com/results?search_query=x"), null);
});

test("get_watch: the player and watch-next parts must agree on the video", () => {
  const data = fixture("get-watch");
  assert.ok(Array.isArray(data) && data.length >= 2);
  const id = core.responseVideoId(data);
  assert.equal(id, data[0].playerResponse.videoDetails.videoId);
  const items = core.collectItems(data, id);
  assert.ok(items.some((it) => it.id === id && it.title?.holder.updatedMetadataEndpoint), "watch title");
  assert.ok(items.some((it) => it.id === id && it.learn === "thumb"), "player videoDetails");
  assert.ok(items.filter((it) => it.id !== id).length > 5, "sidebar lockups");

  const mismatch = [data[0], { watchNextResponse: { currentVideoEndpoint: { watchEndpoint: { videoId: "jNQXAC9IVRw" } } } }];
  assert.equal(core.responseVideoId(mismatch), null);
});

test("thumbInfo separates families and variant signatures", () => {
  const u = (p) => `https://i.ytimg.com/${p}?sqp=abc&rs=def`;
  assert.deepEqual(core.thumbInfo(u("vi/dQw4w9WgXcQ/hqdefault.jpg")), { fam: "h", sig: "" });
  assert.deepEqual(core.thumbInfo(u("vi/dQw4w9WgXcQ/hq720.jpg")), { fam: "h", sig: "" });
  assert.deepEqual(core.thumbInfo("https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/maxresdefault.webp"), { fam: "h", sig: "" });
  assert.deepEqual(core.thumbInfo(u("vi/plN7JMbadRg/hq720_custom_3.jpg")), { fam: "h", sig: "_custom_3" });
  assert.deepEqual(core.thumbInfo(u("vi_lc/v9QtM6qnG50/hq720_es.jpg")), { fam: "h", sig: "_es" });
  assert.deepEqual(core.thumbInfo(u("vi/CEJXqm2eiJ0/sardefault.jpg")), { fam: "v", sig: "" });
  assert.deepEqual(core.thumbInfo(u("vi/CEJXqm2eiJ0/oardefault.jpg")), { fam: "v", sig: "" });
  assert.deepEqual(core.thumbInfo("https://i.ytimg.com/vi/XHragZfSZfM/frame0.jpg"), { fam: "f", sig: "" });
  assert.equal(core.thumbInfo("https://yt3.ggpht.com/abc=s88-c-k"), null);
  assert.equal(core.thumbInfo("https://example.com/vi/dQw4w9WgXcQ/hqdefault.jpg"), null);
});

test("watch page: the autoplay 'Up next' label is never learned as a title", () => {
  const data = fixture("watch-initial-data");
  const label = findAll(data, "playerOverlayAutoplayRenderer")[0].title.simpleText;
  const q = learnable(data);
  assert.ok(q.length > 10);
  assert.ok(!q.some((x) => x.t === label), `"${label}" must not be learned`);

  const items = core.collectItems(data, core.responseVideoId(data));
  const autoplay = items.find((it) => it.title?.key === "videoTitle");
  assert.ok(autoplay, "autoplay overlay is still pinnable (apply-only)");
  assert.equal(autoplay.learn, false);
});

test("watch page: the main title is learned from videoPrimaryInfoRenderer with its own id", () => {
  const data = fixture("watch-initial-data");
  const primary = findAll(data, "videoPrimaryInfoRenderer")[0];
  const q = learnable(data).filter((x) => x.id === "dQw4w9WgXcQ" && x.t);
  assert.ok(q.some((x) => x.t === core.normalizeTitle(core.textOf(primary.title))));
});

test("playlist and mix lockups are ignored", () => {
  const lockup = (contentId, contentType) => ({
    lockupViewModel: {
      contentId,
      contentType,
      metadata: { lockupMetadataViewModel: { title: { content: `Title of ${contentId}` } } },
      contentImage: { thumbnailViewModel: { image: { sources: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }] } } },
    },
  });
  const json = [
    lockup("dQw4w9WgXcQ", "LOCKUP_CONTENT_TYPE_VIDEO"),
    lockup("RDdQw4w9WgXcQ", "LOCKUP_CONTENT_TYPE_PLAYLIST"),
    lockup("jNQXAC9IVRw", "LOCKUP_CONTENT_TYPE_PLAYLIST"),
  ];
  assert.deepEqual(
    core.collectItems(json, null).map((it) => it.id),
    ["dQw4w9WgXcQ"]
  );

  // And on real data: every collected lockup is a video lockup.
  const data = fixture("watch-initial-data");
  const videoIds = new Set(
    findAll(data, "lockupViewModel")
      .filter((l) => l.contentType === "LOCKUP_CONTENT_TYPE_VIDEO")
      .map((l) => l.contentId)
  );
  assert.ok(videoIds.size > 5);
  const collected = new Set(core.collectItems(data, null).map((it) => it.id));
  for (const id of videoIds) assert.ok(collected.has(id), id);
});

test("Shorts first-frame placeholders (reelWatchEndpoint frame0) are never learned", () => {
  for (const name of ["search-initial-data", "channel-shorts"]) {
    const q = learnable(fixture(name));
    assert.ok(q.some((x) => x.th), `${name}: some thumbnails are learnable`);
    assert.ok(!q.some((x) => /frame\d/.test(x.th || "")), `${name}: no frame0 learned`);
  }
});

test("Shorts lockups learn their vertical art and title", () => {
  const q = learnable(fixture("channel-shorts"));
  assert.ok(q.length > 10);
  for (const x of q) {
    assert.equal(x.fam, "v");
    assert.ok(x.t);
  }
});

test("learned thumbnails use the largest size available", () => {
  const data = fixture("search-initial-data");
  const vr = findAll(data, "videoRenderer")[0];
  const largest = [...vr.thumbnail.thumbnails].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const q = learnable(data).find((x) => x.id === vr.videoId);
  assert.equal(q.th, largest.url);
});

test("context-id renderers need a context id; only the Short's own title learns from it", () => {
  const shorts = fixture("shorts-initial-data");
  assert.equal(core.collectItems(shorts, null).length, 0);
  const items = core.collectItems(shorts, "ab8KjD1hDak");
  const title = items.find((it) => it.title?.key === "text");
  assert.ok(title, "Shorts title view model");
  assert.equal(title.learn, true);
  assert.ok(items.filter((it) => it !== title).every((it) => it.learn === false));
});

test("the player's untranslated videoDetails title is applied but never learned", () => {
  const player = fixture("watch-player");
  const q = learnable(player).filter((x) => x.id === player.videoDetails.videoId);
  assert.ok(q.some((x) => x.th), "thumbnail is learned");
  assert.ok(!q.some((x) => x.t), "title is not learned");

  const items = core.collectItems(player, player.videoDetails.videoId);
  assert.ok(core.applyPins(items, { [player.videoDetails.videoId]: { t: "Translated title" } }) >= 1);
  assert.equal(player.videoDetails.title, "Translated title");
});

test("multi-run titles are read whole and written as a single run", () => {
  const json = {
    videoRenderer: {
      videoId: "dQw4w9WgXcQ",
      title: {
        runs: [{ text: "Never gonna " }, { text: "#give", navigationEndpoint: {} }],
        accessibility: { accessibilityData: { label: "Never gonna #give 3 minutes" } },
      },
    },
  };
  const items = core.collectItems(json, null);
  assert.equal(core.toQueryItems(items)[0].t, "Never gonna #give");
  assert.equal(core.applyPins(items, { dQw4w9WgXcQ: { t: "Pinned title" } }), 1);
  assert.deepEqual(json.videoRenderer.title.runs, [{ text: "Pinned title" }]);
  assert.equal(json.videoRenderer.title.accessibility.accessibilityData.label, "Pinned title 3 minutes");
});

test("YouTube Music: song rows are pinned, album/playlist rows are not", () => {
  const search = fixture("music-search");
  const rows = findAll(search, "musicResponsiveListItemRenderer");
  const songs = rows.filter((r) => r.playlistItemData?.videoId);
  assert.ok(songs.length > 3 && songs.length < rows.length, "fixture has song and non-song rows");
  const q = learnable(search);
  assert.deepEqual(
    new Set(q.map((x) => x.id)),
    new Set(songs.map((r) => r.playlistItemData.videoId))
  );
  const first = songs[0];
  const title = first.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs.map((r) => r.text).join("");
  assert.equal(q.find((x) => x.id === first.playlistItemData.videoId).t, core.normalizeTitle(title));
});

test("rewriting runs keeps the first run's link", () => {
  const json = {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: "dQw4w9WgXcQ" },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "Song", navigationEndpoint: { watchEndpoint: { videoId: "dQw4w9WgXcQ" } } }] } } },
      ],
    },
  };
  core.applyPins(core.collectItems(json, null), { dQw4w9WgXcQ: { t: "Pinned song" } });
  const run = json.musicResponsiveListItemRenderer.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0];
  assert.equal(run.text, "Pinned song");
  assert.equal(run.navigationEndpoint.watchEndpoint.videoId, "dQw4w9WgXcQ");
});

test("applyPins leaves a response untouched when pins match what YouTube sent", () => {
  const data = fixture("watch-initial-data");
  const before = JSON.stringify(data);
  const items = core.collectItems(data, core.responseVideoId(data));
  const pins = {};
  for (const q of core.toQueryItems(items)) {
    if (q.learn) pins[q.id] ??= { t: q.t ?? null, th: q.fam === "h" ? q.th : null, tv: q.fam === "v" ? q.th : null };
  }
  assert.equal(core.applyPins(items, pins), 0);
  assert.equal(JSON.stringify(data), before);
});

test("applyPins rewrites a pinned title on lockups, including the a11y label", () => {
  const data = fixture("channel-videos");
  const lockup = findAll(data, "lockupViewModel")[0];
  const items = core.collectItems(data, null);
  assert.equal(core.applyPins(items, { [lockup.contentId]: { t: "First seen title" } }), 1);
  assert.equal(lockup.metadata.lockupMetadataViewModel.title.content, "First seen title");
  assert.ok(lockup.rendererContext.accessibilityContext.label.startsWith("First seen title"));
});

test("thumbnails are only rewritten when the pinned variant differs", () => {
  const id = "plN7JMbadRg";
  const mk = () => ({
    videoRenderer: {
      videoId: id,
      thumbnail: {
        thumbnails: [
          { url: `https://i.ytimg.com/vi/${id}/hq720.jpg?sqp=a`, width: 360, height: 202 },
          { url: `https://i.ytimg.com/vi/${id}/hq720.jpg?sqp=b`, width: 720, height: 404 },
        ],
      },
    },
  });

  const same = mk();
  const sameSize = `https://i.ytimg.com/vi/${id}/hqdefault.jpg?sqp=c`;
  assert.equal(core.applyPins(core.collectItems(same, null), { [id]: { th: sameSize } }), 0, "same variant, other size");
  assert.ok(same.videoRenderer.thumbnail.thumbnails[1].url.includes("hq720.jpg?sqp=b"));

  const other = mk();
  const variant = `https://i.ytimg.com/vi/${id}/hq720_custom_3.jpg?sqp=d`;
  const swaps = [];
  assert.equal(core.applyPins(core.collectItems(other, null), { [id]: { th: variant } }, (...a) => swaps.push(a)), 1);
  assert.ok(other.videoRenderer.thumbnail.thumbnails.every((t) => t.url === variant));
  assert.deepEqual(swaps, [[id, "h", variant, `https://i.ytimg.com/vi/${id}/hq720.jpg?sqp=b`]], "swap reported with the native fallback");

  const vertical = mk();
  const shortsArt = `https://i.ytimg.com/vi/${id}/oardefault_custom_1.jpg`;
  assert.equal(core.applyPins(core.collectItems(vertical, null), { [id]: { th: null, tv: shortsArt } }), 0, "families never mix");
});

test("Shorts title view model: text replaced and stale style offsets dropped", () => {
  const vm = { text: { content: "Original #shorts", styleRuns: [{ startIndex: 9 }], commandRuns: [{ startIndex: 9 }] } };
  const json = { shortsVideoTitleViewModel: vm };
  const items = core.collectItems(json, "ab8KjD1hDak");
  assert.equal(core.applyPins(items, { ab8KjD1hDak: { t: "Pinned" } }), 1);
  assert.deepEqual(vm.text, { content: "Pinned" });
});

test("collectItems gives up (null) when the time budget is exceeded", () => {
  let clock = 0;
  const big = { list: Array.from({ length: 5000 }, () => ({ a: { b: {} } })) };
  assert.equal(core.collectItems(big, null, 10, () => (clock += 5)), null);
  assert.deepEqual(core.collectItems(big, null), []);
});

// --- streaming transform ---------------------------------------------------

function feed(patcher, text, cuts) {
  let out = "";
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out += patcher.push(text.slice(at, cut));
    at = cut;
  }
  return out + patcher.end();
}

test("createStreamPatcher: array elements are patched independently of chunk boundaries", () => {
  const text = ' [ {"a":"x}{\\\"]"} , {"b":[1,{"c":"}"}]} ,3 ]\n';
  const process = (elem) => (elem.includes('"b"') ? '{"b":"patched"}' : null);
  const expected = ' [ {"a":"x}{\\\"]"} , {"b":"patched"} ,3 ]\n';
  for (let i = 0; i <= text.length; i++) {
    for (let j = i; j <= text.length; j += 3) {
      assert.equal(feed(core.createStreamPatcher(process), text, [i, j]), expected, `cuts ${i},${j}`);
    }
  }
});

test("createStreamPatcher forwards each array element as soon as it is complete", () => {
  const patcher = core.createStreamPatcher(() => null);
  assert.equal(patcher.push('[{"player":{"a":1}}'), '[{"player":{"a":1}}');
  assert.equal(patcher.push(',{"next":{"b"'), ",");
  assert.equal(patcher.push(":2}}]"), '{"next":{"b":2}}]');
  assert.equal(patcher.end(), "");
});

test("createStreamPatcher: object documents are processed whole, other text passes through", () => {
  const whole = core.createStreamPatcher((t) => JSON.stringify({ ...JSON.parse(t), p: 1 }));
  assert.equal(whole.push('{"a":'), "");
  assert.equal(whole.push("1}"), "");
  assert.equal(whole.end(), '{"a":1,"p":1}');

  const raw = core.createStreamPatcher(() => "never");
  assert.equal(raw.push(")]}'\n{"), ")]}'\n{");
  assert.equal(raw.end(), "");
});

function jsonResponse(body, { chunks, status = 200, contentType = "application/json; charset=UTF-8" } = {}) {
  const enc = new TextEncoder();
  const parts = chunks || [body];
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    { status, headers: { "content-type": contentType, "content-length": String(body.length) } }
  );
}

test("transformResponse forwards untouched text byte for byte", async () => {
  const body = '{"a" : 1,\n "b":[ "x" ]}';
  const out = core.transformResponse(jsonResponse(body), { endpoint: "next", process: () => 0 });
  assert.equal(await out.text(), body);
});

test("transformResponse rewrites only when something changed and drops stale headers", async () => {
  const out = core.transformResponse(jsonResponse('{"title":"native"}', { chunks: ['{"tit', 'le":"native"}'] }), {
    endpoint: "next",
    process: (json) => {
      json.title = "pinned";
      return 1;
    },
  });
  assert.equal(out.headers.get("content-length"), null);
  assert.equal(out.headers.get("content-type"), "application/json; charset=UTF-8");
  assert.deepEqual(await out.json(), { title: "pinned" });
});

test("transformResponse passes non-JSON and non-200 responses through untouched", () => {
  const text = jsonResponse("hello", { contentType: "text/plain" });
  assert.equal(core.transformResponse(text, { process: () => 1 }), text);
  const notFound = jsonResponse("{}", { status: 404 });
  assert.equal(core.transformResponse(notFound, { process: () => 1 }), notFound);
});

test("transformResponse keeps malformed JSON as is", async () => {
  let errors = 0;
  const out = core.transformResponse(jsonResponse("{not json"), { process: () => 1, onError: () => errors++ });
  assert.equal(await out.text(), "{not json");
  assert.equal(errors, 1);
});

test("transformResponse streams get_watch parts without waiting for the whole body", async () => {
  const enc = new TextEncoder();
  let release;
  const gate = new Promise((r) => (release = r));
  const src = new Response(
    new ReadableStream({
      async start(c) {
        c.enqueue(enc.encode('[{"playerResponse":{"videoDetails":{"videoId":"dQw4w9WgXcQ","title":"T"}}}'));
        await gate;
        c.enqueue(enc.encode(',{"watchNextResponse":{}}]'));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const contexts = [];
  const out = core.transformResponse(src, {
    endpoint: "get_watch",
    process: (json, ctxId) => {
      contexts.push(ctxId);
      return 0;
    },
  });
  const reader = out.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.ok(first.includes("playerResponse"), "player part delivered before the rest arrived");
  release();
  let rest = "";
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  assert.equal(rest, ',{"watchNextResponse":{}}]');
  assert.deepEqual(contexts, ["dQw4w9WgXcQ", null]);
});

test("transformResponse: an abort errors the body like a native fetch", async () => {
  const ctrl = new AbortController();
  const enc = new TextEncoder();
  const src = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('{"a":'));
        ctrl.signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
  const out = core.transformResponse(src, { endpoint: "next", signal: ctrl.signal, process: () => 1 });
  const body = out.text();
  ctrl.abort();
  await assert.rejects(body, (err) => err.name === "AbortError");
});

test("transformResponse: aborted while waiting for the pin store → AbortError, not data", async () => {
  const ctrl = new AbortController();
  const out = core.transformResponse(jsonResponse('{"a":1}'), {
    endpoint: "next",
    signal: ctrl.signal,
    process: () => 0,
    waitUntilReady: async () => ctrl.abort(),
  });
  await assert.rejects(out.text(), (err) => err.name === "AbortError");
});
