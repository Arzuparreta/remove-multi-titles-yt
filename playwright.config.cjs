const { defineConfig } = require("@playwright/test");

/**
 * Extensions are loaded through a persistent context (see tests/support/fixtures.cjs),
 * in Chromium's new headless mode — no Xvfb needed. Set HEADED=1 to watch.
 * Build the Chrome bundle first: `npm run build:chrome-unpacked`.
 */
module.exports = defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.js",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    {
      name: "with-extension",
      use: { withExtension: true },
    },
    {
      name: "no-extension",
      testMatch: "**/nav-integrity.spec.js",
      use: { withExtension: false },
    },
  ],
});
