/* eslint-disable @typescript-eslint/no-require-imports */
const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

/** Chrome MV3 bundle (manifest uses service_worker; repo root manifest is Firefox). */
const extensionPath = path.resolve(__dirname, "dist", "chrome-unpacked");

const chromeDesktop = {
  ...devices["Desktop Chrome"],
  channel: "chromium",
  headless: false,
};

module.exports = defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...chromeDesktop,
  },
  projects: [
    {
      name: "with-extension",
      testMatch: ["**/multi-title-pin.spec.js", "**/sidebar-thumb-nav-debug.spec.js"],
      use: {
        ...chromeDesktop,
        launchOptions: {
          ignoreDefaultArgs: ["--disable-extensions"],
          args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
          ],
        },
      },
    },
    {
      name: "no-extension",
      testMatch: "**/sidebar-thumb-nav-debug.spec.js",
      use: {
        ...chromeDesktop,
        launchOptions: {
          args: [],
        },
      },
    },
  ],
});
