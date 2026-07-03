const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

test("YouTube runtime uses MAIN interceptor before isolated storage bridge", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const scripts = manifest.content_scripts;

  assert.equal(scripts[0].world, "MAIN");
  assert.deepEqual(scripts[0].js, ["content-main.js"]);
  assert.equal(scripts[0].run_at, "document_start");

  assert.equal(scripts[1].world, "ISOLATED");
  assert.deepEqual(scripts[1].js, ["lib/browser-polyfill.min.js", "content.js"]);
  assert.equal(scripts[1].run_at, "document_start");
});

test("Chrome unpacked build copies the MAIN-world interceptor", () => {
  const syncScript = fs.readFileSync(
    path.join(root, "scripts", "sync-chrome-unpacked.mjs"),
    "utf8"
  );
  assert.match(syncScript, /"content-main\.js"/);
});
