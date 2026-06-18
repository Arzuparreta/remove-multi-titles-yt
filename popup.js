/* global chrome */

const api = globalThis.browser ?? chrome;

/** Storage flag shared with content.js. Absent / true = enabled. */
const ENABLED_KEY = "ytPinEnabled";
const GITHUB_URL = "https://github.com/Arzuparreta/remove-multi-titles-yt";

const toggle = document.getElementById("toggle");
const stateText = document.getElementById("stateText");
const ghLink = document.getElementById("ghLink");

ghLink.href = GITHUB_URL;

function render(enabled) {
  toggle.checked = enabled;
  stateText.textContent = enabled ? "Enabled" : "Disabled";
  document.body.classList.toggle("on", enabled);
}

(async () => {
  let enabled = true;
  try {
    const res = await api.storage.local.get(ENABLED_KEY);
    enabled = res[ENABLED_KEY] !== false; // default on
  } catch {
    /* ignore */
  }
  render(enabled);
})();

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  render(enabled);
  try {
    await api.storage.local.set({ [ENABLED_KEY]: enabled });
  } catch {
    /* ignore */
  }
});
