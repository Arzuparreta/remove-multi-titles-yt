/* global chrome */

const api = globalThis.browser ?? chrome;

api.runtime.onInstalled.addListener(() => {});

if (api.webNavigation?.onHistoryStateUpdated) {
  api.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0) return;
    const url = details.url || "";
    if (!url.includes("youtube.com")) return;
    api.tabs.sendMessage(details.tabId, { type: "ytTitleLockHistoryState" }).catch(() => {});
  });
}
