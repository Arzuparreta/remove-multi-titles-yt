#!/usr/bin/env node
/**
 * Navigation-integrity check in real Firefox (Playwright cannot load
 * extensions into Firefox). Drives Firefox over WebDriver BiDi, installs the
 * extension as a temporary add-on and walks YouTube watch pages via the
 * sidebar and channel pages, recording how long each video takes to start
 * playing and whether metadata from a previous view stays on screen.
 *
 * Usage:
 *   node scripts/firefox-nav-check.mjs [--ext <dir>] [--no-ext] [--steps 12]
 *                                      [--reloads 3] [--preload 5000] [--headed]
 *                                      [--debug] [--also <dir>] [--firefox /usr/bin/firefox]
 * --debug turns on the extension's debug log and prints its [ytpin] lines.
 * --also installs another extension next to ours; with
 * tests/support/other-extension it also checks that another extension's
 * InnerTube requests are not rewritten (coexistence with title un-translators).
 * After the navigation steps, the current video is reloaded `--reloads` times
 * with a normal (cache-respecting) reload, which is where YouTube's service
 * worker serves the page.
 * Exit code 1 when a navigation got stuck or leaked.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const EXT_DIR = path.resolve(opt("ext", root));
const WITH_EXT = !flag("no-ext");
const STEPS = Number(opt("steps", 12));
const RELOADS = Number(opt("reloads", 3));
const DEBUG = flag("debug");
const ALSO = opt("also", null) && path.resolve(opt("also"));
const PRELOAD = Number(opt("preload", 5000));
const FIREFOX = opt("firefox", process.env.FIREFOX_BIN || "firefox");
const PORT = 9300 + Math.floor(Math.random() * 500);
const START_VIDEO = "dQw4w9WgXcQ";
/** Seeded pin for START_VIDEO: proves pins really apply in this browser. */
const CHECK_TITLE = "Pinned title (Firefox check)";
const READY_TIMEOUT_MS = 20_000;
const SETTLE_MS = 5_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- extension copy with a storage seeder ----------------------------------
//
// BiDi cannot open moz-extension:// pages, so pins are preloaded by an extra
// background script added to a throwaway copy of the extension.

const work = fs.mkdtempSync(path.join(os.tmpdir(), "ytpin-ff-"));
const profile = path.join(work, "profile");
const extCopy = path.join(work, "ext");
fs.mkdirSync(profile);

function prepareExtension() {
  fs.mkdirSync(extCopy);
  for (const name of fs.readdirSync(EXT_DIR)) {
    const src = path.join(EXT_DIR, name);
    const isDir = fs.statSync(src).isDirectory();
    if (isDir ? ["icons", "lib"].includes(name) : /\.(json|js|html|css)$/.test(name) && !/^package/.test(name)) {
      fs.cpSync(src, path.join(extCopy, name), { recursive: true });
    }
  }
  const manifestPath = path.join(extCopy, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(
    path.join(extCopy, "e2e-seed.js"),
    `browser.runtime.onInstalled.addListener(async () => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const rid = () => Array.from({ length: 11 }, () => abc[Math.floor(Math.random() * 64)]).join("");
  const w = { ytPinSchema: 2, "ytPin:${START_VIDEO}": { t: ${JSON.stringify(CHECK_TITLE)}, th: null, ts: Date.now() } };
  for (let i = 0; i < ${PRELOAD}; i++) {
    const id = rid();
    w["ytPin:" + id] = { t: "Synthetic preloaded title " + i, th: "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg", ts: Date.now() - i * 1000 };
  }
  await browser.storage.local.set(w);
});
`
  );
  manifest.background = { scripts: [...(manifest.background?.scripts || []), "e2e-seed.js"] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// --- Firefox + BiDi ------------------------------------------------------

fs.writeFileSync(
  path.join(profile, "user.js"),
  [
    ["browser.shell.checkDefaultBrowser", false],
    ["browser.startup.homepage_override.mstone", "ignore"],
    ["datareporting.policy.dataSubmissionEnabled", false],
    ["media.autoplay.default", 0],
    ["media.autoplay.blocking_policy", 0],
    ["media.volume_scale", "0.0"],
    ["intl.accept_languages", "es-ES, es"],
  ]
    .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    .join("\n")
);

const ff = spawn(
  FIREFOX,
  [...(flag("headed") ? [] : ["--headless"]), "--no-remote", "--profile", profile, "--remote-debugging-port", String(PORT)],
  { stdio: "ignore" }
);

let ws;
for (let i = 0; i < 100 && !ws; i++) {
  await sleep(200);
  try {
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
      s.onopen = () => resolve(s);
      s.onerror = reject;
    });
  } catch {
    ws = null;
  }
}
if (!ws) throw new Error("could not connect to Firefox WebDriver BiDi");

let seq = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type === "event" && msg.method === "log.entryAdded") {
    const text = msg.params?.text || "";
    if (text.includes("[ytpin]")) console.log(`  ${text}`);
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.type === "error") reject(new Error(`${msg.error}: ${msg.message}`));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function cleanup() {
  try {
    await send("browser.close");
  } catch {
    /* ignore */
  }
  ff.kill();
  await sleep(500);
  fs.rmSync(work, { recursive: true, force: true });
}

/** Evaluates `fn(arg)` in the page and returns its JSON value. */
async function evaluate(context, fn, arg) {
  const r = await send("script.evaluate", {
    expression: `(${fn})(${JSON.stringify(arg ?? null)})`,
    target: { context },
    awaitPromise: true,
    resultOwnership: "none",
  });
  if (r.type === "exception") throw new Error(r.exceptionDetails?.text || "page exception");
  return deserialize(r.result);
}

function deserialize(v) {
  if (!v) return undefined;
  switch (v.type) {
    case "undefined":
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
      return v.value;
    case "array":
      return v.value.map(deserialize);
    case "object":
      return Object.fromEntries(v.value.map(([k, x]) => [typeof k === "string" ? k : deserialize(k), deserialize(x)]));
    default:
      return v.value ?? null;
  }
}

// --- page-side helpers (serialized into the page) -------------------------

const PAGE_PLAYING = (id) => {
  if (new URL(location.href).searchParams.get("v") !== id) return false;
  const p = document.querySelector("#movie_player");
  const vd = p?.getVideoData?.();
  return Boolean(vd && vd.video_id === id && (p.getPlayerState?.() === 1 || p.classList.contains("ad-showing")));
};

/** YouTube's playability status for the loaded video ("OK" when playable). */
const PAGE_PLAYABILITY = () => document.querySelector("#movie_player")?.getPlayerResponse?.()?.playabilityStatus?.status || null;

const PAGE_SNAPSHOT = () => {
  const p = document.querySelector("#movie_player");
  const vd = p?.getVideoData?.() || {};
  const meta = document.querySelector("ytd-watch-metadata");
  return {
    playerTitle: vd.title || null,
    playerAuthor: vd.author || null,
    metaId: meta?.getAttribute("video-id") || null,
    h1: meta?.querySelector("h1")?.innerText || null,
    channel: meta?.querySelector("#owner #channel-name")?.innerText || null,
    channelHref: meta?.querySelector("#owner #channel-name a")?.getAttribute("href") || null,
    playerChannelUrl: p?.getPlayerResponse?.()?.microformat?.playerMicroformatRenderer?.ownerProfileUrl || null,
  };
};

const PAGE_CLICK = ({ sel, visited }) => {
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
};

const PAGE_CLICK_CHANNEL = () => {
  const a = document.querySelector("ytd-watch-metadata #owner #channel-name a");
  if (!a) return false;
  a.click();
  return true;
};

// --- scenario -------------------------------------------------------------

const norm = (s) =>
  String(s || "")
    .replace(/[‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const channelPath = (href) => {
  if (!href) return null;
  try {
    return decodeURIComponent(new URL(href, "https://www.youtube.com").pathname).toLowerCase().replace(/\/$/, "");
  } catch {
    return null;
  }
};

async function poll(fn, timeout, every = 150) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

async function main() {
  await send("session.new", { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } });
  if (WITH_EXT) {
    prepareExtension();
    await send("webExtension.install", { extensionData: { type: "path", path: extCopy } });
    await sleep(1500); // let the seeder finish
  }
  if (ALSO) await send("webExtension.install", { extensionData: { type: "path", path: ALSO } });
  const { contexts } = await send("browsingContext.getTree", {});
  const ctx = contexts[0].context;

  await send("storage.setCookie", {
    cookie: { name: "SOCS", value: { type: "string", value: "CAI" }, domain: ".youtube.com", path: "/", secure: true },
  });

  if (DEBUG) {
    await send("session.subscribe", { events: ["log.entryAdded"] });
    await send("browsingContext.navigate", { context: ctx, url: "https://www.youtube.com/robots.txt", wait: "complete" });
    await evaluate(ctx, () => localStorage.setItem("ytpin:debug", "1"));
  }

  const t0 = Date.now();
  await send("browsingContext.navigate", { context: ctx, url: `https://www.youtube.com/watch?v=${START_VIDEO}`, wait: "interactive" });
  const firstReady = await poll(() => evaluate(ctx, PAGE_PLAYING, START_VIDEO), 30_000);
  const firstMs = firstReady ? Date.now() - t0 : null;
  const pinApplied = WITH_EXT
    ? Boolean(await poll(async () => norm((await evaluate(ctx, PAGE_SNAPSHOT)).h1) === CHECK_TITLE, 10_000))
    : null;
  let coexistence = null;
  if (ALSO && WITH_EXT) {
    const titles = await evaluate(
      ctx,
      async (id) => {
        if (typeof window.__otherExtensionPlayerTitle !== "function") return null;
        const other = await window.__otherExtensionPlayerTitle(id);
        const res = await fetch("/youtubei/v1/player?prettyPrint=false", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: { client: { clientName: "WEB", clientVersion: window.ytcfg.get("INNERTUBE_CLIENT_VERSION") } },
            videoId: id,
          }),
        });
        return { other, page: (await res.json()).videoDetails.title };
      },
      START_VIDEO
    );
    coexistence = Boolean(titles && titles.other !== CHECK_TITLE && titles.page === CHECK_TITLE);
    console.log(`coexistence: other extension got "${titles?.other}", page got "${titles?.page}"`);
  }
  const first = await evaluate(ctx, PAGE_SNAPSHOT);

  const titles = new Set([norm(first.h1), norm(first.playerTitle)].filter(Boolean));
  let prev = { shown: channelPath(first.channelHref), playing: channelPath(first.playerChannelUrl) };
  const visited = [START_VIDEO];
  const steps = [];

  for (let i = 0; i < STEPS; i++) {
    // Every third step goes through the channel page (falls back to the
    // sidebar when the owner block has no single channel link, e.g. collabs).
    let kind = "sidebar";
    let root = "#secondary";
    if (i % 3 === 2 && (await evaluate(ctx, PAGE_CLICK_CHANNEL))) {
      kind = "channel→video";
      await poll(() => evaluate(ctx, () => !location.pathname.startsWith("/watch")), READY_TIMEOUT_MS);
      root = "ytd-browse:not([hidden])";
    }
    let id = await poll(
      () => evaluate(ctx, PAGE_CLICK, { sel: `${root} a[href^='/watch?v=']`, visited }),
      kind === "sidebar" ? READY_TIMEOUT_MS : 8000,
      250
    );
    if (!id) {
      // Channel page without a playable video, or a watch page without related
      // videos (some live streams): go back and pick a related video there.
      await evaluate(ctx, () => history.back());
      await poll(() => evaluate(ctx, () => location.pathname === "/watch"), READY_TIMEOUT_MS);
      kind = "sidebar";
      id = await poll(() => evaluate(ctx, PAGE_CLICK, { sel: "#secondary a[href^='/watch?v=']", visited }), READY_TIMEOUT_MS, 250);
    }
    if (!id) {
      steps.push({ kind, id: null, ms: null, leaks: ["no navigable link found"] });
      break;
    }
    visited.push(id);
    const tc = Date.now();
    const ready = await poll(() => evaluate(ctx, PAGE_PLAYING, id), READY_TIMEOUT_MS, 100);
    const ms = ready ? Date.now() - tc : null;
    if (ms == null) {
      // Upcoming streams, premieres, region/age locks never start: not a stall.
      const status = await evaluate(ctx, PAGE_PLAYABILITY).catch(() => null);
      if (status && status !== "OK") {
        console.log(`(skipped ${id}: ${status})`);
        i--;
        continue;
      }
      steps.push({ kind, id, ms, leaks: ["player never started"] });
      break;
    }
    let snap;
    let leaks;
    const ts = Date.now();
    do {
      snap = await evaluate(ctx, PAGE_SNAPSHOT);
      leaks = [];
      if (snap.metaId !== id) leaks.push(`metadata video-id ${snap.metaId} ≠ ${id}`);
      const h1 = norm(snap.h1);
      if (h1 && h1 !== norm(snap.playerTitle) && titles.has(h1)) leaks.push(`stale title "${h1}"`);
      // The previous video's owner still shown while another channel plays.
      // (URLs, not names: YouTube auto-translates channel names; and the owner
      // link may differ from the uploader, e.g. VEVO → official artist channel.)
      const shown = channelPath(snap.channelHref);
      const playing = channelPath(snap.playerChannelUrl);
      if (shown && playing && prev.shown === shown && prev.playing && prev.playing !== playing) {
        leaks.push(`stale owner "${norm(snap.channel)}" (${shown}) from the previous video; playing channel is ${playing}`);
      }
      if (!leaks.length) break;
      await sleep(250);
    } while (Date.now() - ts < SETTLE_MS);
    steps.push({ kind, id, ms, leaks, h1: snap.h1, playerTitle: snap.playerTitle });
    for (const t of [snap.h1, snap.playerTitle]) if (norm(t)) titles.add(norm(t));
    prev = { shown: channelPath(snap.channelHref), playing: channelPath(snap.playerChannelUrl) };
  }

  const lastId = visited[visited.length - 1];
  for (let i = 0; i < RELOADS && steps.every((s) => s.ms != null); i++) {
    const tr = Date.now();
    await send("browsingContext.reload", { context: ctx, wait: "interactive" });
    const ready = await poll(() => evaluate(ctx, PAGE_PLAYING, lastId), READY_TIMEOUT_MS, 100);
    steps.push({ kind: "reload", id: lastId, ms: ready ? Date.now() - tr : null, leaks: ready ? [] : ["player never started"] });
  }

  const times = steps.map((s) => s.ms).filter((x) => x != null).sort((a, b) => a - b);
  const pct = (p) => (times.length ? times[Math.min(times.length - 1, Math.floor(p * times.length))] : null);
  const summary = {
    browser: "firefox",
    extension: WITH_EXT ? EXT_DIR : "none",
    pinApplied,
    coexistence,
    firstLoadMs: firstMs,
    steps: steps.length,
    stuck: steps.filter((s) => s.ms == null).length,
    leaks: steps.filter((s) => s.leaks.length).length,
    medianMs: pct(0.5),
    p90Ms: pct(0.9),
  };
  for (const s of steps) {
    console.log(`${s.kind.padEnd(14)} ${String(s.id).padEnd(12)} ${String(s.ms ?? "STUCK").padStart(6)} ms  ${s.leaks.join("; ")}`);
  }
  console.log(JSON.stringify(summary));
  return summary;
}

let failed = true;
try {
  const s = await main();
  failed = s.stuck > 0 || s.leaks > 0 || s.firstLoadMs == null || s.pinApplied === false || s.coexistence === false;
} catch (e) {
  console.error(e);
} finally {
  await cleanup();
}
process.exit(failed ? 1 : 0);
