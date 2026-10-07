/**
 * Coexistence with other YouTube extensions. Title un-translators such as
 * YouTube Anti Translate call InnerTube themselves to read a video's original
 * title; those requests must reach them unmodified, while YouTube's own
 * requests still get the pins.
 */
const { test, expect, OTHER_EXTENSION_PATH } = require("./support/fixtures.cjs");

const VIDEO = "dQw4w9WgXcQ";
const PINNED_TITLE = "Pinned first-seen title (coexistence E2E)";

test.use({
  seed: { [`ytPin:${VIDEO}`]: { t: PINNED_TITLE, th: null, tv: null, ts: Date.now() } },
  extraExtensions: [OTHER_EXTENSION_PATH],
});

test("another extension's InnerTube request is not rewritten; the page's own is", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__otherExtensionPlayerTitle === "function" && window.ytcfg?.get, null, {
    timeout: 30_000,
  });

  const fromOtherExtension = await page.evaluate((id) => window.__otherExtensionPlayerTitle(id), VIDEO);
  expect(fromOtherExtension).not.toBe(PINNED_TITLE);
  expect(fromOtherExtension.length).toBeGreaterThan(0);

  const fromPage = await page.evaluate(async (id) => {
    const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: window.ytcfg.get("INNERTUBE_CLIENT_VERSION") } },
        videoId: id,
      }),
    });
    return (await res.json()).videoDetails.title;
  }, VIDEO);
  expect(fromPage).toBe(PINNED_TITLE);
});
