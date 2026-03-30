/* global chrome */

chrome.runtime.onInstalled.addListener(() => {});

// #region agent log — relay debug POSTs (content script cannot fetch localhost without host permission)
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.__ytTitleLockDbg || !msg.body) return;
  fetch("http://127.0.0.1:7816/ingest/ae8860ba-41ab-419d-9a6b-b2e54e56f898", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "301949",
    },
    body: JSON.stringify({ ...msg.body, sessionId: "301949" }),
  }).catch(() => {});
});
// #endregion
