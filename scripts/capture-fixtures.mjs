#!/usr/bin/env node
/**
 * Refreshes tests/fixtures/*.json with real (logged-out) YouTube data so the
 * JSON extractors in content-main.js are tested against what YouTube serves
 * today. Run: `node scripts/capture-fixtures.mjs` (needs network access).
 *
 * Noise that the extension never reads (tracking params, streaming data, ads,
 * framework entities...) is stripped to keep the fixtures small; everything a
 * handler might read or write is kept verbatim.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "tests", "fixtures");

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const HEADERS = { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9", Cookie: "SOCS=CAI" };

const WATCH_ID = "dQw4w9WgXcQ";
const DROP_KEYS = new Set([
  "trackingParams", "clickTrackingParams", "loggingDirectives", "loggingContext",
  "frameworkUpdates", "responseContext", "streamingData", "playbackTracking",
  "playerConfig", "storyboards", "captions", "adPlacements", "adSlots", "playerAds",
  "adBreakHeartbeatParams", "heartbeatParams", "attestation", "topbar", "desktopTopbar",
  "serviceTrackingParams", "webCommandMetadata", "playerParams", "sequenceParams",
  "params", "searchVideoResultEntityKey", "videoDescriptionInfocardsSectionRenderer",
  // Display-only subtrees no handler reads (context menus, overlays, badges...).
  "menu", "menuButton", "menuOnTap", "menuRenderer", "commandContext", "watchEndpointSupportedOnesieConfig",
  "thumbnailOverlays", "inlinePlayerData", "richThumbnail", "inlinePlaybackEndpoint",
  "channelThumbnailSupportedRenderers", "unifiedSharePanelRenderer", "badges", "ownerBadges",
  "detailedMetadataSnippets", "avatar", "serviceEndpoint", "attributedDescription", "overlays",
]);

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (!v || typeof v !== "object") return v;
  const out = {};
  for (const [k, c] of Object.entries(v)) if (!DROP_KEYS.has(k)) out[k] = strip(c);
  return out;
}

/** Extracts the object literal assigned to `name` in an inline script. */
function grab(html, name) {
  const i = html.indexOf(`${name} = `);
  if (i < 0) return null;
  const start = html.indexOf("{", i);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(html.slice(start, j + 1));
  }
  return null;
}

async function page(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}

async function innertube(endpoint, body, clientVersion, { host = "www.youtube.com", clientName = "WEB" } = {}) {
  const res = await fetch(`https://${host}/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json", Origin: `https://${host}` },
    body: JSON.stringify({
      context: { client: { clientName, clientVersion, hl: "es", gl: "ES" } },
      ...body,
    }),
  });
  if (!res.ok) throw new Error(`${endpoint} → HTTP ${res.status}`);
  return res.json();
}

function save(name, obj) {
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(strip(obj))}\n`);
  console.log(`${name}.json  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}

fs.mkdirSync(outDir, { recursive: true });

const watchHtml = await page(`https://www.youtube.com/watch?v=${WATCH_ID}`);
const clientVersion = watchHtml.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
if (!clientVersion) throw new Error("INNERTUBE_CLIENT_VERSION not found");
save("watch-initial-data", grab(watchHtml, "ytInitialData"));
save("watch-player", grab(watchHtml, "ytInitialPlayerResponse"));

const searchHtml = await page("https://www.youtube.com/results?search_query=aviones");
const search = grab(searchHtml, "ytInitialData");
save("search-initial-data", search);

save("channel-videos", grab(await page("https://www.youtube.com/@MrBeast/videos"), "ytInitialData"));
save("channel-shorts", grab(await page("https://www.youtube.com/@MrBeast/shorts"), "ytInitialData"));

const shortId = JSON.stringify(search).match(/"reelWatchEndpoint":\{"videoId":"([\w-]{11})"/)?.[1];
if (shortId) {
  const shortsHtml = await page(`https://www.youtube.com/shorts/${shortId}`);
  save("shorts-initial-data", grab(shortsHtml, "ytInitialData"));
  save("reel-item-watch", await innertube("reel/reel_item_watch", { playerRequest: { videoId: shortId } }, clientVersion));
}

save("next", await innertube("next", { videoId: WATCH_ID }, clientVersion));
save(
  "get-watch",
  await innertube("get_watch", { playerRequest: { videoId: WATCH_ID }, watchNextRequest: { videoId: WATCH_ID } }, clientVersion)
);
save("updated-metadata", await innertube("updated_metadata", { videoId: WATCH_ID }, clientVersion));

// YouTube Music (WEB_REMIX). Its first page embeds data differently, so only
// InnerTube responses are captured.
const musicHtml = await page("https://music.youtube.com/");
const musicVersion = musicHtml.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
if (musicVersion) {
  const music = { host: "music.youtube.com", clientName: "WEB_REMIX" };
  save("music-home", await innertube("browse", { browseId: "FEmusic_home" }, musicVersion, music));
  save("music-search", await innertube("search", { query: "rick astley" }, musicVersion, music));
  save("music-next", await innertube("next", { videoId: WATCH_ID }, musicVersion, music));
}
