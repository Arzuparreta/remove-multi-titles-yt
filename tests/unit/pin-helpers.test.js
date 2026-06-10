/**
 * Unit tests for the pure helpers in content.js (no DOM / no browser storage needed).
 * Run with: npm run test:unit
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  normalizeTitle,
  looksLikeTimestampOrDuration,
  isValidTitle,
  isValidThumb,
  extractVideoId,
  extractVideoIdFromYtNavigateDetail,
  mergeRecord,
  selectKeysToEvict,
  PIN_PREFIX,
  TENTATIVE_SETTLE_MS,
} = require(path.resolve(__dirname, "..", "..", "content.js"));

test("normalizeTitle collapses whitespace and trims", () => {
  assert.equal(normalizeTitle("  a\n  b\t c "), "a b c");
  assert.equal(normalizeTitle(null), "");
  assert.equal(normalizeTitle(undefined), "");
});

test("looksLikeTimestampOrDuration flags bare time strings", () => {
  assert.equal(looksLikeTimestampOrDuration("3:21"), true);
  assert.equal(looksLikeTimestampOrDuration("1:02:03"), true);
  assert.equal(looksLikeTimestampOrDuration(""), true);
  assert.equal(looksLikeTimestampOrDuration("Real Title"), false);
});

test("isValidTitle rejects empty/undefined/timestamps, accepts real titles", () => {
  assert.equal(isValidTitle(""), false);
  assert.equal(isValidTitle("   "), false);
  assert.equal(isValidTitle("undefined"), false);
  assert.equal(isValidTitle(null), false);
  assert.equal(isValidTitle("12:34"), false);
  assert.equal(isValidTitle("Me at the zoo"), true);
});

test("isValidThumb requires a ytimg.com url", () => {
  assert.equal(isValidThumb("https://i.ytimg.com/vi/abc/hq.jpg"), true);
  assert.equal(isValidThumb("https://example.com/x.jpg"), false);
  assert.equal(isValidThumb(null), false);
  assert.equal(isValidThumb(123), false);
});

test("extractVideoId handles watch, shorts, youtu.be, embed", () => {
  assert.equal(
    extractVideoId("https://www.youtube.com/watch?v=jNQXAC9IVRw"),
    "jNQXAC9IVRw"
  );
  assert.equal(
    extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ"
  );
  assert.equal(extractVideoId("https://youtu.be/jNQXAC9IVRw"), "jNQXAC9IVRw");
  assert.equal(
    extractVideoId("https://www.youtube.com/embed/jNQXAC9IVRw"),
    "jNQXAC9IVRw"
  );
  assert.equal(extractVideoId("https://example.com/watch?v=jNQXAC9IVRw"), null);
});

test("extractVideoIdFromYtNavigateDetail reads endpoint payloads", () => {
  assert.equal(
    extractVideoIdFromYtNavigateDetail({
      endpoint: { watchEndpoint: { videoId: "jNQXAC9IVRw" } },
    }),
    "jNQXAC9IVRw"
  );
  assert.equal(extractVideoIdFromYtNavigateDetail(null), null);
  assert.equal(extractVideoIdFromYtNavigateDetail({}), null);
});

test("mergeRecord preserves the other field and refreshes ts", () => {
  const before = Date.now();
  const merged = mergeRecord({ t: "old", th: "https://i.ytimg.com/x.jpg", ts: 1 }, { t: "new" });
  assert.equal(merged.t, "new");
  assert.equal(merged.th, "https://i.ytimg.com/x.jpg"); // untouched
  assert.ok(merged.ts >= before);

  const fresh = mergeRecord(null, { th: "https://i.ytimg.com/y.jpg" });
  assert.equal(fresh.t, null);
  assert.equal(fresh.th, "https://i.ytimg.com/y.jpg");
});

test("selectKeysToEvict returns oldest keys over the cap, none when under", () => {
  const all = {
    other: "ignored",
    [`${PIN_PREFIX}a`]: { t: "a", ts: 30 },
    [`${PIN_PREFIX}b`]: { t: "b", ts: 10 },
    [`${PIN_PREFIX}c`]: { t: "c", ts: 20 },
  };
  assert.deepEqual(selectKeysToEvict(all, 5), []); // under cap
  // cap of 1 keeps newest (ts 30 => 'a'), evicts the two oldest (b=10, c=20)
  const evicted = selectKeysToEvict(all, 1);
  assert.deepEqual(evicted.sort(), [`${PIN_PREFIX}b`, `${PIN_PREFIX}c`].sort());
});

test("TENTATIVE_SETTLE_MS is at least the grid debounce so the 2-pass gate can settle", () => {
  // GRID_DEBOUNCE_MS lives in content.js (300). The 2-pass verification timer
  // must run after the debounce, otherwise it can re-read a card that has
  // not yet finished YouTube's DOM update. Keep this a hard lower bound.
  assert.ok(
    typeof TENTATIVE_SETTLE_MS === "number" && TENTATIVE_SETTLE_MS >= 300,
    `TENTATIVE_SETTLE_MS must be a number >= 300 (got ${TENTATIVE_SETTLE_MS})`
  );
});
