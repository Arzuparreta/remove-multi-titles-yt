/**
 * Compares watch-sidebar thumbnail navigation with the MV3 extension loaded vs plain Chromium.
 *
 * From repo root (Linux without DISPLAY uses Xvfb automatically):
 *   sh scripts/run-sidebar-debug.sh
 * Or:
 *   npm run build:chrome-unpacked && npx playwright test sidebar-thumb-nav-debug.spec.js
 */
const { test, expect } = require("@playwright/test");

/** Entry URL; YouTube may redirect — always exclude the **current** `v` when picking a rec. */
const VIDEO_A = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const FALLBACK_EXCLUDE_VIDEO_ID = "jNQXAC9IVRw";

/**
 * Pick first sidebar watch link that looks like a thumbnail (not title).
 * YouTube varies DOM (compact vs video renderer; <a id="thumbnail"> may be in light DOM).
 * @param {import('@playwright/test').Page} page
 */
async function pickSidebarThumbLink(page, excludeId) {
  return page.evaluate((excludeId) => {
    const isSidebarTitleLink = (a) => {
      if (a.id === "video-title-link") return true;
      if (a.closest("#video-title")) return true;
      if (a.closest("h3.ytd-compact-video-renderer, h3.ytd-video-renderer")) return true;
      return false;
    };

    const isLikelyVisibleThumbRow = (a) => {
      if (a.classList.contains("yt-video-attribute-view-model__content-container"))
        return false;
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none")
        return false;
      const r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) return false;
      return true;
    };

    const all = document.querySelectorAll("#secondary a[href*='watch?v=']");
    /** @type {HTMLAnchorElement[]} */
    const thumbish = [];
    /** @type {HTMLAnchorElement[]} */
    const nonTitle = [];

    for (const a of all) {
      const href = a.getAttribute("href") || "";
      if (href.includes(excludeId)) continue;
      try {
        const u = new URL(href, location.origin);
        const v = u.searchParams.get("v");
        if (!v || !/^[a-zA-Z0-9_-]{11}$/.test(v)) continue;
      } catch {
        continue;
      }

      if (isSidebarTitleLink(a)) continue;
      if (!isLikelyVisibleThumbRow(a)) continue;
      nonTitle.push(a);

      const id = a.id || "";
      if (id === "thumbnail") thumbish.push(a);
      else if (a.querySelector(":scope > img, :scope yt-img-shadow img")) thumbish.push(a);
      else if (a.closest("ytd-thumbnail")) thumbish.push(a);
    }

    const ordered = [...all];
    const linkIndexOf = (a) => ordered.indexOf(a);

    const tryPick = (a, reason) => {
      const href = a.getAttribute("href") || "";
      try {
        const u = new URL(href, location.origin);
        const v = u.searchParams.get("v");
        if (!v || !/^[a-zA-Z0-9_-]{11}$/.test(v)) return null;
        const cs = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        return {
          v,
          href: a.href,
          linkIndex: linkIndexOf(a),
          pickReason:
            reason ||
            (a.id === "thumbnail"
              ? "id=thumbnail"
              : a.closest("ytd-thumbnail")
                ? "inside-ytd-thumbnail"
                : "img-child"),
          diag: {
            pointerEvents: cs.pointerEvents,
            display: cs.display,
            visibility: cs.visibility,
            rect: { w: r.width, h: r.height, top: r.top, left: r.left },
            anchorId: a.id || null,
          },
        };
      } catch {
        return null;
      }
    };

    for (const a of thumbish) {
      const p = tryPick(
        a,
        a.id === "thumbnail"
          ? "id=thumbnail"
          : a.closest("ytd-thumbnail")
            ? "inside-ytd-thumbnail"
            : "img-child"
      );
      if (p) return p;
    }

    for (const a of nonTitle) {
      const p = tryPick(a, "first-non-title-watch-link");
      if (p) return p;
    }

    return {
      miss: true,
      secondaryPresent: !!document.querySelector("#secondary"),
      compactCount: document.querySelectorAll("#secondary ytd-compact-video-renderer").length,
      videoRendererCount: document.querySelectorAll("#secondary ytd-video-renderer").length,
      thumbIdCount: document.querySelectorAll('#secondary a[id="thumbnail"]').length,
      anyWatchInSecondary: all.length,
      nonTitleWatchCount: nonTitle.length,
    };
  }, excludeId);
}

test.describe("debug: sidebar thumbnail → watch navigation", () => {
  test("thumbnail link click changes video id", async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const project = testInfo.project.name;

    await page.goto(VIDEO_A, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    const consent = page.locator(
      'button:has-text("Accept all"), button:has-text("Reject all"), [aria-label*="Accept"]'
    );
    if (await consent.first().isVisible().catch(() => false)) {
      await consent.first().click().catch(() => {});
      await page.waitForTimeout(2000);
    }

    await page
      .locator("#secondary ytd-compact-video-renderer, #secondary ytd-thumbnail")
      .first()
      .waitFor({ state: "attached", timeout: 60_000 })
      .catch(() => {});

    await page.waitForTimeout(2000);

    let excludeId = FALLBACK_EXCLUDE_VIDEO_ID;
    try {
      const cur = new URL(page.url()).searchParams.get("v");
      if (cur && /^[a-zA-Z0-9_-]{11}$/.test(cur)) excludeId = cur;
    } catch {
      /* keep default */
    }

    const pick = await pickSidebarThumbLink(page, excludeId);

    if (pick && pick.miss) {
      console.log(`\n[${project}] SKIP diagnostics:`, JSON.stringify(pick, null, 2));
      test.skip(
        true,
        "No sidebar ytd-thumbnail watch link found — see console diagnostics (consent, layout, geo)"
      );
      return;
    }

    if (!pick || !pick.v) {
      console.log(`\n[${project}] Unexpected pick:`, pick);
      test.skip(true, "pickSidebarThumbLink returned empty");
      return;
    }

    if (pick.linkIndex == null || pick.linkIndex < 0) {
      test.skip(true, "pick missing linkIndex");
      return;
    }

    const thumb = page.locator("#secondary a[href*='watch?v=']").nth(pick.linkIndex);
    await thumb.waitFor({ state: "attached", timeout: 45_000 });
    await thumb.scrollIntoViewIfNeeded();

    const urlBefore = page.url();

    console.log(`\n========== [${project}] ==========`);
    console.log("Expected next video id:", pick.v);
    console.log("Pick reason / linkIndex:", pick.pickReason, pick.linkIndex);
    console.log("Thumbnail diagnostics:", JSON.stringify(pick.diag, null, 2));
    console.log("URL before click:", urlBefore);

    const navPromise = page.waitForURL(
      (url) =>
        url.hostname.includes("youtube") &&
        url.searchParams.get("v") === pick.v,
      { timeout: 35_000 }
    );

    await thumb.click({ timeout: 15_000, force: false });

    let navigated = true;
    await navPromise.catch(() => {
      navigated = false;
    });

    const urlAfter = page.url();
    let vAfter = null;
    try {
      vAfter = new URL(urlAfter).searchParams.get("v");
    } catch {
      /* ignore */
    }

    console.log("URL after click:", urlAfter);
    console.log("v param after:", vAfter);
    console.log("waitForURL satisfied:", navigated);
    console.log("=====================================\n");

    expect(
      vAfter,
      `[${project}] Thumbnail click should navigate to v=${pick.v}. ` +
        `If no-extension passes and with-extension fails, the bug is extension-specific.`
    ).toBe(pick.v);
  });
});
