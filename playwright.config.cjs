/* eslint-disable @typescript-eslint/no-require-imports */
const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const extensionPath = path.resolve(__dirname);

module.exports = defineConfig({
  testDir: "tests",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    ...devices["Desktop Chrome"],
    channel: "chromium",
    headless: false,
    launchOptions: {
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  },
});
