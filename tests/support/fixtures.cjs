/**
 * Shared Playwright fixtures.
 *
 * Chromium only loads unpacked extensions in a *persistent* context, so the
 * default `browser.newContext()` page fixture would silently run without the
 * extension. These fixtures launch a throwaway persistent profile per test,
 * in Chromium's new headless mode (which supports extensions, no Xvfb needed).
 *
 * Options (set per project in playwright.config.cjs or via test.use):
 *   withExtension  load dist/chrome-unpacked (default true)
 *   preloadPins    number of synthetic ytPin: records to seed before the test
 *   seed           extra extension-storage entries to write before the test
 *   extraExtensions  other unpacked extensions to load alongside ours
 *
 * Env:
 *   HEADED=1            show the browser window
 *   PW_CHROMIUM_PATH    use a specific Chromium/Chrome-for-Testing binary
 */
const { test: base, expect, chromium } = require("@playwright/test");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXTENSION_PATH = path.resolve(__dirname, "..", "..", "dist", "chrome-unpacked");

/** Chrome derives an unpacked extension's id from the sha256 of its path. */
function unpackedExtensionId(absPath) {
  const hex = crypto.createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const test = base.extend({
  withExtension: [true, { option: true }],
  preloadPins: [0, { option: true }],
  seed: [{}, { option: true }],
  extraExtensions: [[], { option: true }],

  context: async ({ withExtension, preloadPins, seed, extraExtensions }, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytpin-e2e-"));
    const args = ["--autoplay-policy=no-user-gesture-required", "--mute-audio"];
    const extensions = [...(withExtension ? [EXTENSION_PATH] : []), ...extraExtensions];
    if (extensions.length) {
      args.push(`--disable-extensions-except=${extensions.join(",")}`, `--load-extension=${extensions.join(",")}`);
    }
    const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: !process.env.HEADED,
      locale: "es-ES",
      viewport: { width: 1366, height: 900 },
      args,
    });
    // Skip the EU consent interstitial.
    await context.addCookies([
      { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/", secure: true },
    ]);

    if (withExtension && (preloadPins > 0 || Object.keys(seed).length)) {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${unpackedExtensionId(EXTENSION_PATH)}/popup.html`);
      await page.evaluate(async ({ n, seed }) => {
        const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const rid = () => Array.from({ length: 11 }, () => abc[Math.floor(Math.random() * 64)]).join("");
        const writes = { ytPinSchema: 2 };
        const now = Date.now();
        for (let i = 0; i < n; i++) {
          const id = rid();
          writes[`ytPin:${id}`] = {
            t: `Synthetic preloaded title number ${i}`,
            th: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            ts: now - i * 1000,
          };
        }
        await chrome.storage.local.set({ ...writes, ...seed });
      }, { n: preloadPins, seed });
      await page.close();
    }

    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});

/** Reads the extension's storage.local (through its popup page). */
async function readExtensionStorage(context, keys = null) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${unpackedExtensionId(EXTENSION_PATH)}/popup.html`);
    return await page.evaluate((keys) => chrome.storage.local.get(keys), keys);
  } finally {
    await page.close();
  }
}

const OTHER_EXTENSION_PATH = path.resolve(__dirname, "other-extension");

module.exports = { test, expect, unpackedExtensionId, readExtensionStorage, EXTENSION_PATH, OTHER_EXTENSION_PATH };
