/**
 * Append one NDJSON line for Cursor debug analysis (same machine as repo — works over SSH workflows).
 */
const fs = require("fs");
const path = require("path");

const LOG_REL = path.join(".cursor", "debug-301949.log");

function logPath() {
  return path.join(__dirname, "..", "..", LOG_REL);
}

function appendDebug(payload) {
  const p = logPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({
    sessionId: "301949",
    timestamp: Date.now(),
    runId: "playwright",
    ...payload,
  });
  fs.appendFileSync(p, line + "\n", "utf8");
}

function clearDebugLog() {
  try {
    fs.unlinkSync(logPath());
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

module.exports = { appendDebug, clearDebugLog, logPath };
