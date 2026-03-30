#!/usr/bin/env node
/**
 * Chrome MV3 requires background.service_worker; Firefox uses background.scripts.
 * Builds dist/chrome-unpacked/ with a Chrome manifest and copied scripts.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "chrome-unpacked");
const libOut = path.join(out, "lib");

const rootFiles = ["background.js", "content.js"];

fs.mkdirSync(libOut, { recursive: true });

const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const chromeManifest = {
  ...manifest,
  background: { service_worker: "background.js" },
};
fs.writeFileSync(
  path.join(out, "manifest.json"),
  `${JSON.stringify(chromeManifest, null, 2)}\n`
);

for (const f of rootFiles) {
  fs.copyFileSync(path.join(root, f), path.join(out, f));
}

const libDir = path.join(root, "lib");
for (const name of fs.readdirSync(libDir)) {
  const p = path.join(libDir, name);
  if (fs.statSync(p).isFile()) {
    fs.copyFileSync(p, path.join(libOut, name));
  }
}

console.log("Chrome unpacked →", out);
