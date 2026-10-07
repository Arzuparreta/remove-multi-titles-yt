/**
 * Regression coverage for the cross-search title/thumbnail leak.
 *
 * Symptom (v2.2 DOM-based pinning): searching for B after A could show B's
 * thumbnail with A's title on the same card, because YouTube recycles card
 * DOM and the extension learned from a half-updated card. Pins are now
 * learned from YouTube's JSON, where the id and the title live in the same
 * object, so recycling cannot mix them up — these tests guard that.
 *
 * Test 1 (full reload): the second search page must not show the first
 * search's first-card title.
 *
 * Test 2 (SPA search submit): drives a new search via the masthead form,
 * the in-page flow that recycles card DOM. Skipped defensively if the input
 * cannot be located (consent dialog, locale, layout).
 */
const { test, expect } = require("./support/fixtures.cjs");

const CARD_SEL = "ytd-video-renderer, ytd-rich-item-renderer";

function normalize(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

async function firstCardTitle(page) {
  return page.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const t = card.querySelector("#video-title");
    return t ? t.textContent : null;
  }, CARD_SEL);
}

test.describe("grid pin: search → search does not leak titles across results", () => {
  test("full reload of a second search: first card title differs from the first search's", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto("https://www.youtube.com/results?search_query=aviones", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(5000);
    const tA = await firstCardTitle(page);
    test.skip(!tA, "no card visible in search A");

    await page.goto("https://www.youtube.com/results?search_query=ardillas", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(5000);
    const tB = await firstCardTitle(page);
    test.skip(!tB, "no card visible in search B");

    expect(
      normalize(tB),
      "First card of the second search should not show the first search's title"
    ).not.toBe(normalize(tA));
  });

  test("SPA search submit: first card title is the new search's, not the previous one", async ({
    page,
  }) => {
    test.setTimeout(180_000);

    await page.goto("https://www.youtube.com/results?search_query=aviones", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(5000);
    const tA = await firstCardTitle(page);
    test.skip(!tA, "no card visible in search A");

    // Drive a SPA search via the masthead input + form submit (recycles card DOM).
    const submitted = await page.evaluate(() => {
      const input = document.querySelector("input[name='search_query']");
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      setter.call(input, "ardillas");
      const form = input.form || input.closest("form");
      if (!form) return false;
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      return true;
    });
    test.skip(!submitted, "masthead search input not available (consent / locale / layout)");

    await page.waitForTimeout(5000);
    const tB = await firstCardTitle(page);
    test.skip(!tB, "no card visible after SPA search submit");

    expect(
      normalize(tB),
      "After SPA search submit, the first card should show the new search's title"
    ).not.toBe(normalize(tA));
  });
});
