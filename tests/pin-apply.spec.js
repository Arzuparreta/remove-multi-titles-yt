/**
 * Simulated A/B test: a pin whose title differs from what YouTube serves must
 * win everywhere the video is rendered — list cards (full page load,
 * ytInitialData path), the watch page reached by SPA navigation (get_watch
 * path), the player's own title and the tab title — and must not be flipped
 * back by YouTube's updated_metadata poll.
 *
 * The seeded thumbnail pin is a variant that does not exist on the CDN (like
 * a losing "Test & compare" variant after the test ends): the card must fall
 * back to YouTube's own thumbnail and the broken thumbnail pin is forgotten.
 */
const { test, expect, readExtensionStorage } = require("./support/fixtures.cjs");

const VIDEO = "dQw4w9WgXcQ";
const PINNED_TITLE = "Pinned first-seen title (E2E)";
const DEAD_VARIANT = `https://i.ytimg.com/vi/${VIDEO}/hqdefault_custom_1.jpg`;
const SHORT = "CEJXqm2eiJ0"; // a MrBeast Short
const PINNED_SHORT_TITLE = "Pinned first-seen Short title (E2E)";

test.use({
  seed: {
    [`ytPin:${VIDEO}`]: { t: PINNED_TITLE, th: DEAD_VARIANT, tv: null, ts: Date.now() },
    [`ytPin:${SHORT}`]: { t: PINNED_SHORT_TITLE, th: null, tv: null, ts: Date.now() },
  },
});

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function watchState(page) {
  return page.evaluate(() => {
    const p = document.querySelector("#movie_player");
    return {
      id: p?.getVideoData?.()?.video_id,
      playerTitle: p?.getVideoData?.()?.title,
      h1: document.querySelector("ytd-watch-metadata h1")?.innerText,
      docTitle: document.title,
    };
  });
}

async function expectPinnedWatch(page) {
  await expect.poll(async () => (await watchState(page)).id, { timeout: 30_000 }).toBe(VIDEO);
  await expect.poll(async () => norm((await watchState(page)).h1), { timeout: 15_000 }).toBe(PINNED_TITLE);
  const s = await watchState(page);
  expect(norm(s.playerTitle)).toBe(PINNED_TITLE);
  expect(s.docTitle).toContain(PINNED_TITLE);

  // YouTube polls updated_metadata ~3 s after load; the pin must survive it.
  await page.waitForTimeout(6000);
  expect(norm((await watchState(page)).h1)).toBe(PINNED_TITLE);
}

test("search card shows the pinned title, heals a dead thumbnail variant; SPA watch page stays pinned", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.goto("https://www.youtube.com/results?search_query=rick+astley+never+gonna+give+you+up", {
    waitUntil: "domcontentloaded",
  });

  const cardTitle = await page
    .waitForFunction(
      (id) => {
        const link = document.querySelector(`ytd-search a[href^="/watch?v=${id}"]`);
        const card = link?.closest("ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer");
        return (card && (card.querySelector("#video-title") || card.querySelector("h3"))?.innerText) || null;
      },
      VIDEO,
      { timeout: 30_000, polling: 250 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  test.skip(!cardTitle, "video not found in search results (locale / layout)");
  expect(norm(cardTitle)).toBe(PINNED_TITLE);

  // The dead variant fails to load → YouTube's own thumbnail is shown and the
  // thumbnail pin is dropped (the title pin stays).
  await expect
    .poll(
      () =>
        page.evaluate((id) => {
          const link = document.querySelector(`ytd-search a[href^="/watch?v=${id}"]`);
          const img = link?.closest("ytd-video-renderer, yt-lockup-view-model")?.querySelector("img");
          return img?.src || "";
        }, VIDEO),
      { timeout: 15_000 }
    )
    .toMatch(new RegExp(`/vi/${VIDEO}/(?!hqdefault_custom_1)`));
  await expect
    .poll(async () => (await readExtensionStorage(context, `ytPin:${VIDEO}`))[`ytPin:${VIDEO}`]?.th ?? null, {
      timeout: 15_000,
    })
    .not.toBe(DEAD_VARIANT);
  expect((await readExtensionStorage(context, `ytPin:${VIDEO}`))[`ytPin:${VIDEO}`].t).toBe(PINNED_TITLE);

  await page.evaluate((id) => {
    document.querySelector(`ytd-search a[href^="/watch?v=${id}"]`).click();
  }, VIDEO);
  await expectPinnedWatch(page);
});

test("full load of a pinned watch page shows the pin", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}`, { waitUntil: "domcontentloaded" });
  await expectPinnedWatch(page);
});

test("a pinned Short keeps its title on load and when swiped back to", async ({ page }) => {
  test.setTimeout(120_000);
  const shortTitle = () =>
    page.evaluate(() => {
      const p = document.querySelector("#shorts-player");
      return {
        id: p?.getVideoData?.()?.video_id,
        title: document.querySelector("ytd-shorts yt-shorts-video-title-view-model h1")?.innerText,
      };
    });

  await page.goto(`https://www.youtube.com/shorts/${SHORT}`, { waitUntil: "domcontentloaded" });
  await expect.poll(async () => (await shortTitle()).id, { timeout: 30_000 }).toBe(SHORT);
  await expect.poll(async () => norm((await shortTitle()).title), { timeout: 15_000 }).toBe(PINNED_SHORT_TITLE);

  await page.keyboard.press("ArrowDown");
  await page.waitForURL((u) => !u.pathname.endsWith(SHORT), { timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press("ArrowUp");
  await page.waitForURL((u) => u.pathname.endsWith(SHORT), { timeout: 20_000 });
  await expect.poll(async () => (await shortTitle()).id, { timeout: 20_000 }).toBe(SHORT);
  await expect.poll(async () => norm((await shortTitle()).title), { timeout: 15_000 }).toBe(PINNED_SHORT_TITLE);
});
