/**
 * Unit tests for the pure interception helpers in content-main.js (MAIN world).
 * The bootstrap is guarded for non-browser environments, so requiring the file
 * in Node just returns its exported helpers.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  isValidId,
  isValidThumb,
  parseThumb,
  buildBaseThumb,
  writeThumbToObj,
  readVideoId,
  classify,
  collectVideoEntries,
  shouldApplyTitlesForUrl,
} = require(path.resolve(__dirname, "..", "..", "content-main.js"));

test("player responses keep native titles for title-untranslator compatibility", () => {
  assert.equal(
    shouldApplyTitlesForUrl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false"),
    false
  );
  assert.equal(
    shouldApplyTitlesForUrl("https://www.youtube.com/youtubei/v1/browse?prettyPrint=false"),
    true
  );
  assert.equal(shouldApplyTitlesForUrl("https://www.youtube.com/oembed?url=x"), true);
});

test("readVideoId accepts 11-char ids and rejects playlist contentIds", () => {
  assert.equal(readVideoId({ videoId: "jNQXAC9IVRw" }), "jNQXAC9IVRw");
  assert.equal(readVideoId({ videoDetails: { videoId: "dQw4w9WgXcQ" } }), "dQw4w9WgXcQ");
  // A video lockup carries the videoId in contentId.
  assert.equal(readVideoId({ contentId: "aaaaaaaaaaa" }), "aaaaaaaaaaa");
  // A playlist id is longer than 11 chars and must be rejected.
  assert.equal(readVideoId({ contentId: "PLabcdefghijklmnop" }), null);
  assert.equal(readVideoId({}), null);
});

test("classify maps renderer sources to learn policy", () => {
  assert.equal(classify("videoRenderer", {}), "video");
  assert.equal(classify("compactVideoRenderer", {}), "video");
  assert.equal(classify("videoDetails", {}), "video");
  assert.equal(classify("reelItemRenderer", {}), "short");
  assert.equal(classify("shortsLockupViewModel", {}), "short");
  assert.equal(
    classify("lockupViewModel", { contentType: "LOCKUP_CONTENT_TYPE_VIDEO" }),
    "video"
  );
  assert.equal(
    classify("lockupViewModel", { contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" }),
    "skip"
  );
  assert.equal(classify("someUnknownRenderer", {}), "skip");
});

test("parseThumb splits resolution and A/B variant", () => {
  const a = parseThumb("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg?sqp=x&rs=y");
  assert.deepEqual(
    { id: a.id, res: a.res, variant: a.variant, webp: a.webp, ext: a.ext },
    { id: "dQw4w9WgXcQ", res: "hqdefault", variant: "", webp: false, ext: "jpg" }
  );
  const b = parseThumb("https://i9.ytimg.com/vi/dQw4w9WgXcQ/hqdefault_custom_2.jpg?sqp=x");
  assert.equal(b.variant, "_custom_2");
  assert.equal(b.res, "hqdefault");
  const c = parseThumb("https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/mqdefault.webp");
  assert.equal(c.webp, true);
  assert.equal(c.res, "mqdefault");
  assert.equal(parseThumb("https://example.com/x.jpg"), null);
});

test("writeThumbToObj pins the variant while preserving each resolution", () => {
  // Pinning the ORIGINAL variant rewrites custom URLs to clean param-less bases,
  // keeping each entry's own resolution.
  const obj = {
    thumbnail: {
      thumbnails: [
        { url: "https://i9.ytimg.com/vi/dQw4w9WgXcQ/mqdefault_custom_1.jpg?sqp=a", width: 320 },
        { url: "https://i9.ytimg.com/vi/dQw4w9WgXcQ/hqdefault_custom_1.jpg?sqp=b", width: 480 },
      ],
    },
  };
  const changed = writeThumbToObj(obj, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(changed, true);
  assert.equal(obj.thumbnail.thumbnails[0].url, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
  assert.equal(obj.thumbnail.thumbnails[1].url, "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");

  // Same variant already present => no change.
  const noop = {
    thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }] },
  };
  assert.equal(writeThumbToObj(noop, "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"), false);
});

test("collectVideoEntries classifies videos vs playlists and skips playlist thumbs", () => {
  const root = {
    contents: [
      {
        richItemRenderer: {
          content: {
            videoRenderer: {
              videoId: "jNQXAC9IVRw",
              title: { runs: [{ text: "Real Video" }] },
              thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/jNQXAC9IVRw/hq.jpg" }] },
            },
          },
        },
      },
      {
        lockupViewModel: {
          contentId: "PLplaylist1234567",
          contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
          metadata: { lockupMetadataViewModel: { title: { content: "A Playlist" } } },
          contentImage: {
            thumbnailViewModel: { image: { sources: [{ url: "https://i.ytimg.com/vi/other/hq.jpg" }] } },
          },
        },
      },
    ],
  };
  const entries = collectVideoEntries(root, 100);
  // Only the real video is collected; the playlist id is rejected by readVideoId.
  assert.equal(entries.length, 1);
  assert.equal(entries[0].videoId, "jNQXAC9IVRw");
  assert.equal(entries[0].kind, "video");
  assert.ok(isValidThumb(entries[0].thumbUrl));
});

test("buildBaseThumb / isValidId basics", () => {
  assert.equal(buildBaseThumb("dQw4w9WgXcQ", "hqdefault", false), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(buildBaseThumb("dQw4w9WgXcQ", "mqdefault", true), "https://i.ytimg.com/vi_webp/dQw4w9WgXcQ/mqdefault.webp");
  assert.equal(isValidId("dQw4w9WgXcQ"), true);
  assert.equal(isValidId("tooshort"), false);
  assert.equal(isValidId("PLabcdefghijklmnop"), false);
});
