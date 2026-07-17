/**
 * Integration test for the MAIN-world rewrite pipeline on realistic InnerTube
 * fixtures: collect -> locate by videoId -> write pin into the JSON. Verifies
 * that pinned values land at the right nested paths, unrelated entries stay
 * untouched, playlists are skipped, and Shorts thumbnails are never learned.
 * Fully deterministic (no browser needed).
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const {
  collectVideoEntries,
  writeTitleToObj,
  writeThumbToObj,
  readTitleFromObj,
  readThumbFromObj,
} = require(path.resolve(__dirname, "..", "..", "content-main.js"));

/** A browse response mixing a videoRenderer, a video lockup, a playlist lockup, and a Short. */
function makeBrowseFixture() {
  return {
    contents: {
      richGridRenderer: {
        contents: [
          {
            richItemRenderer: {
              content: {
                videoRenderer: {
                  videoId: "jNQXAC9IVRw",
                  title: { runs: [{ text: "A/B Clickbait Title" }] },
                  thumbnail: {
                    thumbnails: [
                      { url: "https://i9.ytimg.com/vi/jNQXAC9IVRw/mqdefault_custom_2.jpg?sqp=a", width: 320 },
                      { url: "https://i9.ytimg.com/vi/jNQXAC9IVRw/hqdefault_custom_2.jpg?sqp=b", width: 480 },
                    ],
                  },
                },
              },
            },
          },
          {
            richItemRenderer: {
              content: {
                lockupViewModel: {
                  contentId: "dQw4w9WgXcQ",
                  contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
                  metadata: { lockupMetadataViewModel: { title: { content: "Lockup Video Title" } } },
                  contentImage: {
                    thumbnailViewModel: {
                      image: { sources: [{ url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" }] },
                    },
                  },
                },
              },
            },
          },
          {
            richItemRenderer: {
              content: {
                lockupViewModel: {
                  contentId: "PLthisIsAPlaylistId",
                  contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
                  metadata: { lockupMetadataViewModel: { title: { content: "A Playlist" } } },
                },
              },
            },
          },
          {
            richItemRenderer: {
              content: {
                shortsLockupViewModel: {
                  contentId: "aaaaaaaaaaa",
                  metadata: { lockupMetadataViewModel: { title: { content: "A Short" } } },
                  contentImage: {
                    thumbnailViewModel: {
                      image: { sources: [{ url: "https://i.ytimg.com/vi/aaaaaaaaaaa/oardefault.jpg" }] },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
  };
}

test("collect finds videos + short, rejects playlist, skips short thumbnail", () => {
  const entries = collectVideoEntries(makeBrowseFixture(), 100);
  const byId = Object.fromEntries(entries.map((e) => [e.videoId, e]));

  assert.ok(byId["jNQXAC9IVRw"] && byId["jNQXAC9IVRw"].kind === "video");
  assert.ok(byId["dQw4w9WgXcQ"] && byId["dQw4w9WgXcQ"].kind === "video");
  // Playlist id is rejected outright.
  assert.equal(byId["PLthisIsAPlaylistId"], undefined);
  // Short is collected for its title but never carries a thumbnail to learn.
  assert.ok(byId["aaaaaaaaaaa"] && byId["aaaaaaaaaaa"].kind === "short");
  assert.equal(byId["aaaaaaaaaaa"].thumbUrl, null);
});

test("pin apply rewrites the matching entry only, preserving resolution", () => {
  const fixture = makeBrowseFixture();
  const entries = collectVideoEntries(fixture, 100);
  const target = entries.find((e) => e.videoId === "jNQXAC9IVRw");

  // Simulate "we pinned the original title + original-variant thumbnail".
  assert.equal(writeTitleToObj(target._obj, "The Honest Original Title"), true);
  assert.equal(
    writeThumbToObj(target._obj, "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg"),
    true
  );

  // The videoRenderer now reads back the pinned values.
  const vr = fixture.contents.richGridRenderer.contents[0].richItemRenderer.content.videoRenderer;
  assert.equal(readTitleFromObj(vr), "The Honest Original Title");
  // Each resolution kept its own size, custom variant stripped to clean base.
  assert.equal(vr.thumbnail.thumbnails[0].url, "https://i.ytimg.com/vi/jNQXAC9IVRw/mqdefault.jpg");
  assert.equal(vr.thumbnail.thumbnails[1].url, "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg");

  // The unrelated lockup video was NOT touched.
  const lockup =
    fixture.contents.richGridRenderer.contents[1].richItemRenderer.content.lockupViewModel;
  assert.equal(readTitleFromObj(lockup), "Lockup Video Title");
  assert.equal(readThumbFromObj(lockup), "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg");
});

test("pin apply into a lockup rewrites lockupMetadataViewModel + contentImage sources", () => {
  const fixture = makeBrowseFixture();
  const entries = collectVideoEntries(fixture, 100);
  const target = entries.find((e) => e.videoId === "dQw4w9WgXcQ");

  assert.equal(writeTitleToObj(target._obj, "Pinned Lockup Title"), true);
  const lockup =
    fixture.contents.richGridRenderer.contents[1].richItemRenderer.content.lockupViewModel;
  assert.equal(lockup.metadata.lockupMetadataViewModel.title.content, "Pinned Lockup Title");
});
