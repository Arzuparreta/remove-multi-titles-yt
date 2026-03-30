/**
 * Repro: open watch page A, then navigate to watch page B.
 * If the extension mis-associates the player title, the h1 can still show A's title on B.
 *
 * Requires: headed Chromium (extensions do not load in headless).
 * YouTube may show consent interstitial on first run — complete it once in the opened browser.
 */
const { test, expect } = require("@playwright/test");

/** Public videos (no login). */
const VIDEO_A = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // Me at the zoo
const VIDEO_B = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Different video

const titleHeading = "#primary h1.ytd-watch-metadata";

async function dumpWatchDebug(page) {
  return page.evaluate(() => {
    const href = location.href;
    const players = [
      ...document.querySelectorAll(
        "#primary ytd-player, ytd-watch-flexy ytd-player"
      ),
    ].map((p) => ({
      videoId: p.getAttribute("video-id"),
    }));
    const metas = [
      ...document.querySelectorAll("#primary ytd-watch-metadata"),
    ].map((m, i) => ({
      i,
      videoId: m.getAttribute("video-id"),
      h1: m.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() ?? "",
    }));
    return { href, players, metas };
  });
}

test.describe("watch title after SPA-style navigation", () => {
  test("title on B differs from title on A (full navigation)", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.locator(titleHeading).first().waitFor({ state: "visible" });
    await page.waitForTimeout(2000);

    const debugA = await dumpWatchDebug(page);
    const titleA = (await page.locator(titleHeading).first().innerText()).trim();

    await page.goto(VIDEO_B, { waitUntil: "domcontentloaded" });
    await page.locator(titleHeading).first().waitFor({ state: "visible" });
    await page.waitForTimeout(2500);

    const debugB = await dumpWatchDebug(page);
    const titleB = (await page.locator(titleHeading).first().innerText()).trim();

    // eslint-disable-next-line no-console
    console.log("DEBUG after A:", JSON.stringify({ ...debugA, titleA }, null, 2));
    // eslint-disable-next-line no-console
    console.log("DEBUG after B:", JSON.stringify({ ...debugB, titleB }, null, 2));

    expect(titleB.length, "title B should be non-empty").toBeGreaterThan(0);
    expect(
      titleB,
      `Expected watch page B title to differ from A (got same: "${titleB}")`
    ).not.toBe(titleA);
  });

  test("title changes after in-page click to another watch link (sidebar SPA)", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.locator(titleHeading).first().waitFor({ state: "visible" });
    await page.waitForTimeout(3000);

    const titleA = (await page.locator(titleHeading).first().innerText()).trim();

    const clickedId = await page.evaluate((excludeId) => {
      const sel =
        "#secondary a[href*='/watch?v='], ytd-watch-next-secondary-results-renderer a[href*='/watch?v=']";
      const links = Array.from(document.querySelectorAll(sel));
      for (const a of links) {
        const href = a.getAttribute("href") || "";
        if (href.includes(excludeId)) continue;
        try {
          const u = new URL(href, location.origin);
          const v = u.searchParams.get("v");
          if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) {
            a.click();
            return v;
          }
        } catch {
          continue;
        }
      }
      return null;
    }, "jNQXAC9IVRw");

    if (!clickedId) {
      test.skip(true, "No secondary watch link other than video A (layout or locale)");
    }

    await page.waitForURL(
      (url) => url.searchParams.get("v") === clickedId,
      { timeout: 90_000 }
    );
    await page.locator(titleHeading).first().waitFor({ state: "visible" });
    await page.waitForTimeout(3000);

    const debugAfter = await dumpWatchDebug(page);
    const titleAfter = (await page.locator(titleHeading).first().innerText()).trim();

    // eslint-disable-next-line no-console
    console.log(
      "DEBUG SPA click:",
      JSON.stringify({ clickedId, titleA, titleAfter, ...debugAfter }, null, 2)
    );

    expect(titleAfter.length).toBeGreaterThan(0);
    expect(titleAfter, `Title stuck on first video after sidebar click`).not.toBe(
      titleA
    );
  });
});
