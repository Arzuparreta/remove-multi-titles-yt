#!/usr/bin/env node
/**
 * Builds dist/chrome-unpacked/ for Chrome (Load unpacked / Web Store ZIP).
 * Same files as the Firefox package; the manifest drops the Gecko-only
 * `browser_specific_settings`, which Chrome warns about.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "chrome-unpacked");

const rootFiles = ["content-main.js", "content.js", "popup.html", "popup.css", "popup.js"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "icons"), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
delete manifest.browser_specific_settings;
fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const f of rootFiles) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}

for (const name of fs.readdirSync(path.join(root, "icons"))) {
  if (name.endsWith(".png")) {
    fs.copyFileSync(path.join(root, "icons", name), path.join(out, "icons", name));
  }
}

console.log("Chrome unpacked →", out);
