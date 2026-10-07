/**
 * Unit tests for the pin store in content.js (no DOM / no browser storage).
 * Run with: npm run test:unit
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  PIN_PREFIX,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  TOUCH_AFTER_MS,
  isVideoId,
  normalizeTitle,
  isValidTitle,
  isValidThumb,
  thumbFamily,
  cacheKey,
  mergeRecord,
  resolveItems,
  forgetThumbs,
  mergeStored,
  selectKeysToEvict,
  sanitizeRecord,
  planMigration,
} = require(path.resolve(__dirname, "..", "..", "content.js"));

const A = "dQw4w9WgXcQ";
const B = "jNQXAC9IVRw";
const C = "ab8KjD1hDak";
const TH = (id, name = "hqdefault") => `https://i.ytimg.com/vi/${id}/${name}.jpg`;

test("normalizeTitle / isValidTitle", () => {
  assert.equal(normalizeTitle("  a\n  b\t c "), "a b c");
  assert.equal(normalizeTitle(null), "");
  for (const bad of ["", "   ", "undefined", null, 42, "12:34", "1:02:03", "x".repeat(501)]) {
    assert.equal(isValidTitle(bad), false, String(bad));
  }
  assert.equal(isValidTitle("Me at the zoo"), true);
});

test("isVideoId is anchored", () => {
  assert.equal(isVideoId(A), true);
  assert.equal(isVideoId(`RD${A}`), false);
  assert.equal(isVideoId("abc"), false);
});

test("isValidThumb / thumbFamily", () => {
  assert.equal(isValidThumb(TH(A)), true);
  assert.equal(isValidThumb(`https://i.ytimg.com/vi_lc/${A}/hq720_es.jpg?sqp=x`), true);
  assert.equal(isValidThumb("https://yt3.ggpht.com/avatar=s48"), false);
  assert.equal(isValidThumb("https://example.com/x.jpg"), false);
  assert.equal(isValidThumb(123), false);
  assert.equal(thumbFamily(TH(A, "hq720_custom_2")), "h");
  assert.equal(thumbFamily(TH(A, "sardefault")), "v");
  assert.equal(thumbFamily(TH(A, "oar2")), "v");
  assert.equal(thumbFamily(TH(A, "frame0")), "f");
});

test("mergeRecord keeps untouched fields and stamps ts", () => {
  const merged = mergeRecord({ t: "old", th: TH(A), tv: null, ts: 1 }, { t: "new" }, 99);
  assert.deepEqual(merged, { t: "new", th: TH(A), tv: null, ts: 99 });
  assert.deepEqual(mergeRecord(null, { tv: TH(A, "sardefault") }, 5), { t: null, th: null, tv: TH(A, "sardefault"), ts: 5 });
});

test("resolveItems learns first-seen values and returns pins", () => {
  const cache = new Map();
  const { pins, dirty } = resolveItems(cache, [{ id: A, learn: true, t: "Title A", th: TH(A), fam: "h" }], "", 1000);
  assert.deepEqual(pins[A], { t: "Title A", th: TH(A), tv: null });
  assert.deepEqual(dirty, [A]);
  assert.equal(cache.get(A).ts, 1000);
});

test("resolveItems: within one query the first occurrence of an id wins", () => {
  const cache = new Map();
  const { pins } = resolveItems(
    cache,
    [
      { id: A, learn: true, t: "First" },
      { id: A, learn: true, t: "Second" },
    ],
    "",
    1
  );
  assert.equal(pins[A].t, "First");
  assert.equal(cache.get(A).t, "First");
});

test("resolveItems never overwrites an existing pin and never learns from apply-only items", () => {
  const cache = new Map([[A, { t: "Pinned", th: TH(A), tv: null, ts: 10 }]]);
  const { pins, dirty } = resolveItems(
    cache,
    [
      { id: A, learn: true, t: "A/B variant", th: TH(A, "hqdefault_custom_2"), fam: "h" },
      { id: B, t: "Up next label" },
    ],
    "",
    20
  );
  assert.deepEqual(pins[A], { t: "Pinned", th: TH(A), tv: null });
  assert.equal(pins[B], undefined);
  assert.equal(cache.has(B), false);
  assert.deepEqual(dirty, []);
});

test("resolveItems fills a missing field and keeps thumbnail families apart", () => {
  const cache = new Map([[A, { t: "Pinned", th: null, tv: null, ts: 10 }]]);
  resolveItems(cache, [{ id: A, learn: true, th: TH(A, "sardefault"), fam: "v" }], "", 20);
  assert.equal(cache.get(A).tv, TH(A, "sardefault"));
  assert.equal(cache.get(A).th, null);
  // A wrong family claim or a raw frame is never stored.
  resolveItems(cache, [{ id: A, learn: true, th: TH(A, "frame0"), fam: "h" }], "", 30);
  assert.equal(cache.get(A).th, null);
});

test("resolveItems refreshes the LRU timestamp at most once a day", () => {
  const cache = new Map([[A, { t: "Pinned", th: null, tv: null, ts: 0 }]]);
  let r = resolveItems(cache, [{ id: A }], "", TOUCH_AFTER_MS + 1);
  assert.deepEqual(r.dirty, [A]);
  assert.equal(cache.get(A).ts, TOUCH_AFTER_MS + 1);
  r = resolveItems(cache, [{ id: A }], "", TOUCH_AFTER_MS + 2);
  assert.deepEqual(r.dirty, []);
});

test("resolveItems keeps YouTube Music pins in their own namespace", () => {
  const cache = new Map([[A, { t: "Video title", th: null, tv: null, ts: 1 }]]);
  const { pins } = resolveItems(cache, [{ id: A, learn: true, t: "Song title" }], "m", 2);
  assert.equal(pins[A].t, "Song title");
  assert.equal(cache.get(cacheKey("m", A)).t, "Song title");
  assert.equal(cache.get(A).t, "Video title");
});

test("resolveItems ignores malformed items", () => {
  const cache = new Map();
  const { pins } = resolveItems(cache, [null, { id: "RDxx" }, { id: A, learn: true, t: 5, th: "javascript:1", fam: "h" }], "", 1);
  assert.deepEqual(pins, {});
  assert.equal(cache.size, 0);
});

test("mergeStored: values already in storage win (first write wins across tabs)", () => {
  const mine = { t: "Mine", th: TH(A), tv: null, ts: 50 };
  assert.deepEqual(mergeStored(undefined, mine), { t: "Mine", th: TH(A), tv: null, ts: 50 });
  assert.deepEqual(mergeStored({ t: "Theirs", th: null, ts: 70 }, mine), { t: "Theirs", th: TH(A), tv: null, ts: 70 });
});

test("forgetThumbs drops a broken thumbnail pin, and the store does not resurrect it", () => {
  const broken = TH(A, "hq720_custom_2");
  const cache = new Map([[A, { t: "Pinned", th: broken, tv: TH(A, "sardefault"), ts: 1 }]]);
  assert.deepEqual(forgetThumbs(cache, [{ id: A, fam: "h" }, { id: B, fam: "h" }, { id: "bad" }], "", 9), [A]);
  assert.deepEqual(cache.get(A), { t: "Pinned", th: null, tv: TH(A, "sardefault"), ts: 9 });

  const stored = { t: "Pinned", th: broken, tv: TH(A, "sardefault"), ts: 1 };
  assert.equal(mergeStored(stored, cache.get(A), new Set(["th"])).th, null);
  assert.equal(mergeStored(stored, cache.get(A)).th, broken, "without the forgotten flag storage wins");
});

test("selectKeysToEvict drops the least recently seen", () => {
  const cache = new Map([
    ["a", { ts: 30 }],
    ["b", { ts: 10 }],
    ["c", { ts: 20 }],
  ]);
  assert.deepEqual(selectKeysToEvict(cache, 5), []);
  assert.deepEqual(selectKeysToEvict(cache, 1).sort(), ["b", "c"]);
});

test("sanitizeRecord", () => {
  assert.equal(sanitizeRecord(null), null);
  assert.deepEqual(sanitizeRecord({ t: "  T  ", th: TH(A, "frame0"), ts: 3 }), { t: "T", th: null, tv: null, ts: 3 });
  assert.deepEqual(sanitizeRecord({ t: null, th: TH(A, "oardefault") }), { t: null, th: null, tv: TH(A, "oardefault"), ts: 0 });
});

test("planMigration v3 cleans v2.4 data", () => {
  const all = {
    ytPinEnabled: false,
    ytPinSchema: 2,
    [`${PIN_PREFIX}${A}`]: { t: "Real title A", th: TH(A), ts: 5 },
    [`${PIN_PREFIX}RDdQw4w9WgXcQ`]: { t: "Mix - Rick Astley", th: TH(A), ts: 5 },
    [`${PIN_PREFIX}${B}`]: { t: "A continuación", th: TH(B, "frame0"), ts: 5 },
    [`${PIN_PREFIX}${C}`]: { t: "A continuación", th: TH(C), ts: 5 },
    [`${PIN_PREFIX}zzzzzzzzzzz`]: { t: "A continuación", th: null, ts: 5 },
    "ytTitleLock:Xy3_4-abcde": "Legacy title",
    "ytThumbLock:Xy3_4-abcde": TH("Xy3_4-abcde"),
  };
  const { set, remove } = planMigration(all);

  assert.equal(set[SCHEMA_KEY], SCHEMA_VERSION);
  assert.equal(set.ytPinEnabled, undefined, "unrelated keys untouched");
  assert.equal(set[`${PIN_PREFIX}${A}`], undefined, "clean records are not rewritten");
  assert.ok(!remove.includes(`${PIN_PREFIX}${A}`));
  assert.ok(remove.includes(`${PIN_PREFIX}RDdQw4w9WgXcQ`), "playlist/mix ids removed");
  assert.ok(remove.includes(`${PIN_PREFIX}${B}`), "label title + frame0 → nothing left");
  assert.ok(remove.includes(`${PIN_PREFIX}zzzzzzzzzzz`));
  assert.deepEqual(set[`${PIN_PREFIX}${C}`], { t: null, th: TH(C), tv: null, ts: 5 }, "shared label dropped, thumb kept");
  assert.deepEqual(set[`${PIN_PREFIX}Xy3_4-abcde`], { t: "Legacy title", th: TH("Xy3_4-abcde"), tv: null, ts: 0 });
  assert.ok(remove.includes("ytTitleLock:Xy3_4-abcde") && remove.includes("ytThumbLock:Xy3_4-abcde"));
});
