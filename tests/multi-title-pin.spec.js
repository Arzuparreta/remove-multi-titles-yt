/**
 * Pin invariants for "multi titles should not repeat" behaviour.
 *
 * YouTube does not swap A/B titles on every refresh, and many videos never participate.
 * These tests assert what the extension *must* do when a first title is seen: keep that
 * string on return visits and avoid drift on the same page — not that YouTube served two
 * variants in this run.
 */
const { test, expect } = require("@playwright/test");

const WATCH_H1 = "#primary h1.ytd-watch-metadata";

/** Public, stable watch URLs (no login). */
const VIDEO_A = "https://www.youtube.com/watch?v=jNQXAC9IVRw"; // Me at the zoo
const VIDEO_B = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"; // Different video

async function readWatchTitle(page) {
  const loc = page.locator(WATCH_H1).first();
  await loc.waitFor({ state: "visible" });
  return normalize((await loc.innerText()) || "");
}

function normalize(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

test.describe("pinned watch title — multi-variant repetition guard", () => {
  test("first title for video A is shown again after leaving and full-return (goto A→B→A)", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const titleAFirst = await readWatchTitle(page);
    expect(titleAFirst.length, "video A should have a non-empty title").toBeGreaterThan(0);

    await page.goto(VIDEO_B, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const titleB = await readWatchTitle(page);
    expect(titleB).not.toBe(titleAFirst);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const titleASecond = await readWatchTitle(page);

    expect(
      titleASecond,
      "returning to A must show the same pinned title as the first visit (no alternate variant)"
    ).toBe(titleAFirst);
  });

  test("watch title text is stable across several seconds on one load", async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      samples.push(await readWatchTitle(page));
      if (i < 2) await page.waitForTimeout(4000);
    }
    const [t0, t1, t2] = samples;
    expect(t0.length).toBeGreaterThan(0);
    expect(t1, "title at +4s should match initial (no mid-page A/B swap)").toBe(t0);
    expect(t2, "title at +8s should match initial").toBe(t0);
  });

  test("SPA sidebar: title for B differs from A; returning via goto A still matches first A pin", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2800);
    const titleAFirst = await readWatchTitle(page);

    const clickedId = await page.evaluate((excludeId) => {
      const sel =
        "#secondary a[href*='/watch?v='], ytd-watch-next-secondary-results-renderer a[href*='/watch?v=']";
      for (const a of document.querySelectorAll(sel)) {
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

    test.skip(!clickedId, "No secondary watch link other than A (layout/locale)");

    await page.waitForURL(
      (url) => url.searchParams.get("v") === clickedId,
      { timeout: 90_000 }
    );
    await page.waitForTimeout(2800);
    const titleAfterB = await readWatchTitle(page);
    expect(titleAfterB).not.toBe(titleAFirst);

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2800);
    const titleAAgain = await readWatchTitle(page);
    expect(titleAAgain).toBe(titleAFirst);
  });
});
