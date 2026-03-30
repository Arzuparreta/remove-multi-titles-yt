/**
 * web-ext discovers this file automatically.
 * @see https://extensionworkshop.com/documentation/develop/web-ext-command-reference/
 */
export default {
  sourceDir: ".",
  artifactsDir: "dist-amo",
  ignoreFiles: [
    "package.json",
    "package-lock.json",
    "playwright.config.cjs",
    "README.md",
    "STORE_SUBMISSION.md",
    "web-ext-config.mjs",
    "tests",
    "tests/**",
    "scripts",
    "scripts/**",
    "playwright-report",
    "playwright-report/**",
    "test-results",
    "test-results/**",
    "blob-report/**",
    "dist-amo/**",
    "web-ext-artifacts/**",
    ".cursor/**",
  ],
  build: {
    overwriteDest: true,
  },
};
