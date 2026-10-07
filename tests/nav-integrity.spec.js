/**
 * Navigation integrity: the extension must never slow YouTube down, stall the
 * player, or leave metadata from a previous view on screen.
 *
 * Runs in both Playwright projects (with-extension / no-extension) so the
 * numbers can be compared side by side. Each step records the ms until the
 * player is actually playing the target video, and any leak.
 *
 * A "leak" is metadata from another view still on screen SETTLE_MS after the
 * player is ready: a watch-metadata `video-id` that is not the playing video,
 * the previous step's owner link while the playing video belongs to another
 * channel, or a title equal to one shown in a previous step but not the
 * current video's. Names are not compared directly — YouTube auto-translates
 * titles and channel names — and the owner link may legitimately differ from
 * the uploader (VEVO uploads show the official artist channel).
 */
const { test, expect } = require("./support/fixtures.cjs");

const START_VIDEO = "dQw4w9WgXcQ";
const STEPS = Number(process.env.NAV_STEPS) || 10;
const READY_TIMEOUT_MS = 20_000;
const SETTLE_MS = 5_000;

test.use({ preloadPins: 5000 });

function norm(s) {
  return String(s || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const WATCH_LINK = "a[href^='/watch?v=']";

/** Waits for, then clicks, the first laid-out unvisited single-video link under `root`. */
async function clickVideoLink(page, root, visited) {
  const handle = await page
    .waitForFunction(
      ({ sel, visited }) => {
        for (const a of document.querySelectorAll(sel)) {
          const u = new URL(a.getAttribute("href"), location.origin);
          const v = u.searchParams.get("v");
          if (!v || visited.includes(v) || u.searchParams.has("list")) continue;
          const r = a.getBoundingClientRect();
          if (r.width < 40 || r.height < 20) continue;
          a.scrollIntoView({ block: "center" });
          a.click();
          return v;
        }
        return null;
      },
      { sel: `${root} ${WATCH_LINK}`, visited },
      { timeout: READY_TIMEOUT_MS, polling: 250 }
    )
    .catch(() => null);
  return handle ? handle.jsonValue() : null;
}

/** Resolves with ms until the watch player plays `id`, or null on timeout. */
async function waitWatchPlaying(page, id) {
  const t0 = Date.now();
  while (Date.now() - t0 < READY_TIMEOUT_MS) {
    const ok = await page
      .evaluate((id) => {
        if (new URL(location.href).searchParams.get("v") !== id) return false;
        const p = document.querySelector("#movie_player");
        const vd = p?.getVideoData?.();
        if (!vd || vd.video_id !== id) return false;
        return p.getPlayerState?.() === 1 || p.classList.contains("ad-showing");
      }, id)
      .catch(() => false);
    if (ok) return Date.now() - t0;
    await page.waitForTimeout(100);
  }
  return null;
}

async function watchSnapshot(page) {
  return page.evaluate(() => {
    const p = document.querySelector("#movie_player");
    const vd = p?.getVideoData?.() || {};
    const meta = document.querySelector("ytd-watch-metadata");
    return {
      url: new URL(location.href).searchParams.get("v"),
      playerId: vd.video_id,
      playerTitle: vd.title,
      playerAuthor: vd.author,
      metaId: meta?.getAttribute("video-id"),
      h1: meta?.querySelector("h1")?.innerText,
      channel: meta?.querySelector("#owner #channel-name")?.innerText,
      channelHref: meta?.querySelector("#owner #channel-name a")?.getAttribute("href"),
      playerChannelUrl: p?.getPlayerResponse?.()?.microformat?.playerMicroformatRenderer?.ownerProfileUrl,
      docTitle: document.title,
    };
  });
}

function channelPath(href) {
  if (!href) return null;
  try {
    return decodeURIComponent(new URL(href, "https://www.youtube.com").pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/** Leaks in a watch snapshot, given what earlier steps showed. */
function watchLeaks(s, id, history) {
  const out = [];
  if (s.metaId !== id) out.push(`metadata video-id ${s.metaId} ≠ ${id}`);
  const h1 = norm(s.h1);
  if (h1 && h1 !== norm(s.playerTitle) && history.titles.has(h1)) out.push(`stale title "${h1}"`);
  const shown = channelPath(s.channelHref);
  const playing = channelPath(s.playerChannelUrl);
  const prev = history.prev;
  if (shown && playing && prev?.shown === shown && prev.playing && prev.playing !== playing) {
    out.push(`stale owner "${norm(s.channel)}" (${shown}) from the previous video; playing channel is ${playing}`);
  }
  return out;
}

function rememberChannel(history, s) {
  history.prev = { shown: channelPath(s.channelHref), playing: channelPath(s.playerChannelUrl) };
}

/** Polls until no leak remains or SETTLE_MS passes; returns leaks + last snapshot. */
async function settledWatch(page, id, history) {
  const t0 = Date.now();
  let snap;
  let leaks;
  do {
    snap = await watchSnapshot(page);
    leaks = watchLeaks(snap, id, history);
    if (!leaks.length) break;
    await page.waitForTimeout(250);
  } while (Date.now() - t0 < SETTLE_MS);
  return { snap, leaks };
}

function remember(history, ...titles) {
  for (const t of titles) if (norm(t)) history.titles.add(norm(t));
}

/** Opens a related video; pages without one (e.g. some live streams) are left via Back. */
async function clickSidebarVideo(page, visited) {
  const id = await clickVideoLink(page, "#secondary", visited);
  if (id) return id;
  await page.goBack().catch(() => {});
  await page.waitForURL((u) => u.pathname === "/watch", { timeout: READY_TIMEOUT_MS }).catch(() => {});
  return clickVideoLink(page, "#secondary", visited);
}

/** Goes to the owner's channel and opens one of its videos; null if there is no single channel link. */
async function clickChannelThenVideo(page, visited) {
  const clicked = await page.evaluate(() => {
    const a = document.querySelector("ytd-watch-metadata #owner #channel-name a");
    if (!a) return false;
    a.click();
    return true;
  });
  if (!clicked) return null;
  await page.waitForURL((u) => !u.pathname.startsWith("/watch"), { timeout: READY_TIMEOUT_MS });
  const id = await clickVideoLink(page, "ytd-browse:not([hidden])", visited);
  if (!id) {
    // Channel page without a playable video (only playlists, posts...): go back.
    await page.goBack().catch(() => {});
    await page.waitForURL((u) => u.pathname === "/watch", { timeout: READY_TIMEOUT_MS }).catch(() => {});
  }
  return id;
}

function report(testInfo, label, steps) {
  const times = steps.map((s) => s.ms).filter((x) => x != null).sort((a, b) => a - b);
  const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null);
  const summary = {
    project: testInfo.project.name,
    label,
    steps: steps.length,
    stuck: steps.filter((s) => s.ms == null).length,
    leaks: steps.filter((s) => s.mismatches.length).length,
    medianMs: pct(0.5),
    p90Ms: pct(0.9),
  };
  console.log(`[nav-integrity] ${JSON.stringify(summary)}`);
  console.log(`  ms per step: ${steps.map((s) => s.ms ?? "-").join(" ")}`);
  for (const s of steps) if (s.mismatches.length) console.log(`  leak @${s.id} (${s.kind}): ${s.mismatches.join("; ")}`);
  testInfo.attach(`${label}.json`, {
    body: JSON.stringify({ summary, steps }, null, 2),
    contentType: "application/json",
  });
  return summary;
}

test.describe("navigation integrity", () => {
  test("watch → watch (sidebar) and channel → video", async ({ page }, testInfo) => {
    test.setTimeout(STEPS * 45_000 + 60_000);

    await page.goto(`https://www.youtube.com/watch?v=${START_VIDEO}`, { waitUntil: "domcontentloaded" });
    const firstMs = await waitWatchPlaying(page, START_VIDEO);
    expect(firstMs, "first watch page should start playing").not.toBeNull();

    const visited = [START_VIDEO];
    const steps = [];
    const history = { titles: new Set() };
    const first = await watchSnapshot(page);
    remember(history, first.h1, first.playerTitle);
    rememberChannel(history, first);
    for (let i = 0; i < STEPS; i++) {
      // Every third step goes through the channel page (falls back to the
      // sidebar when the owner block has no single channel link, e.g. collabs).
      let kind = i % 3 === 2 ? "channel→video" : "sidebar";
      let id = kind === "sidebar" ? null : await clickChannelThenVideo(page, visited);
      if (!id && kind !== "sidebar" && new URL(page.url()).pathname === "/watch") kind = "sidebar";
      if (kind === "sidebar") id = await clickSidebarVideo(page, visited);
      if (!id) {
        steps.push({ kind, id: null, ms: null, mismatches: ["no navigable link found"] });
        break;
      }
      visited.push(id);
      const ms = await waitWatchPlaying(page, id);
      if (ms == null) {
        // Upcoming streams, premieres, region/age locks never start: not a stall.
        const status = await page
          .evaluate(() => document.querySelector("#movie_player")?.getPlayerResponse?.()?.playabilityStatus?.status)
          .catch(() => null);
        if (status && status !== "OK") {
          i--;
          continue;
        }
        steps.push({ kind, id, ms, mismatches: ["player never started"] });
        break;
      }
      const { snap, leaks } = await settledWatch(page, id, history);
      steps.push({ kind, id, ms, mismatches: leaks, h1: snap.h1, channel: snap.channel });
      remember(history, snap.h1, snap.playerTitle);
      rememberChannel(history, snap);
    }

    const summary = report(testInfo, "watch-navigation", steps);
    expect(summary.stuck, "no navigation may leave the player loading").toBe(0);
    expect(summary.leaks, "metadata must match the playing video").toBe(0);
  });

  test("Shorts: swiping keeps the title in sync with the playing short", async ({ page }, testInfo) => {
    test.setTimeout(STEPS * 30_000 + 60_000);

    await page.goto("https://www.youtube.com/shorts", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/shorts\/[\w-]{11}/, { timeout: READY_TIMEOUT_MS });

    const steps = [];
    const history = { titles: new Set() };
    for (let i = 0; i < STEPS; i++) {
      const id = new URL(page.url()).pathname.split("/")[2];
      const t0 = Date.now();
      let ms = null;
      let mismatches = [];
      while (Date.now() - t0 < READY_TIMEOUT_MS) {
        const s = await page.evaluate(() => {
          const p = document.querySelector("#shorts-player");
          const vd = p?.getVideoData?.() || {};
          const h1 = document.querySelector("ytd-shorts yt-shorts-video-title-view-model h1");
          return { playerId: vd.video_id, playerTitle: vd.title, playing: p?.getPlayerState?.() === 1, title: h1?.innerText };
        });
        if (s.playerId === id && s.playing) {
          ms ??= Date.now() - t0;
          const title = norm(s.title);
          const stale = title && title !== norm(s.playerTitle) && history.titles.has(title);
          mismatches = stale ? [`stale title "${title}" (player "${norm(s.playerTitle)}")`] : [];
          if (!stale || Date.now() - t0 - ms > SETTLE_MS) {
            remember(history, s.title, s.playerTitle);
            break;
          }
        }
        await page.waitForTimeout(150);
      }
      if (ms == null) mismatches = ["short never started"];
      steps.push({ kind: "short", id, ms, mismatches });
      if (ms == null) break;
      await page.keyboard.press("ArrowDown");
      await page.waitForURL((u) => !u.pathname.endsWith(id), { timeout: READY_TIMEOUT_MS }).catch(() => {});
    }

    const summary = report(testInfo, "shorts-navigation", steps);
    expect(summary.stuck).toBe(0);
    expect(summary.leaks).toBe(0);
  });
});
