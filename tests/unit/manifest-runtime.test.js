const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

test("MAIN interceptor and ISOLATED pin store both run at document_start", () => {
  const [main, isolated] = manifest.content_scripts;

  assert.equal(main.world, "MAIN");
  assert.deepEqual(main.js, ["content-main.js"]);
  assert.equal(main.run_at, "document_start");

  assert.equal(isolated.world, "ISOLATED");
  assert.deepEqual(isolated.js, ["content.js"]);
  assert.equal(isolated.run_at, "document_start");
});

test("no background script and only the storage permission", () => {
  assert.equal(manifest.background, undefined);
  assert.deepEqual(manifest.permissions, ["storage"]);
});

test("every file the manifest references exists and is copied into the Chrome build", () => {
  const syncScript = fs.readFileSync(path.join(root, "scripts", "sync-chrome-unpacked.mjs"), "utf8");
  for (const entry of manifest.content_scripts) {
    for (const f of entry.js) {
      assert.ok(fs.existsSync(path.join(root, f)), `${f} exists`);
      assert.match(syncScript, new RegExp(`"${f.replace(".", "\\.")}"`), `${f} copied`);
    }
  }
  assert.ok(fs.existsSync(path.join(root, manifest.action.default_popup)));
});
