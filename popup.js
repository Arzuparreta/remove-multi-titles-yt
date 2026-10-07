/* global chrome */

const api = globalThis.browser ?? chrome;

/** Storage flag shared with content.js. Absent / true = enabled. */
const ENABLED_KEY = "ytPinEnabled";
const PIN_PREFIX = "ytPin:";
const GITHUB_URL = "https://github.com/Arzuparreta/remove-multi-titles-yt";
const CONFIRM_MS = 4000;

const toggle = document.getElementById("toggle");
const stateText = document.getElementById("stateText");
const hint = document.getElementById("hint");
const stats = document.getElementById("stats");
const clearBtn = document.getElementById("clearBtn");
const ghLink = document.getElementById("ghLink");

ghLink.href = GITHUB_URL;

let pinKeys = [];
let confirmTimer = null;

function render(enabled) {
  toggle.checked = enabled;
  stateText.textContent = enabled ? "Enabled" : "Disabled";
  document.body.classList.toggle("on", enabled);
}

function renderStats() {
  const n = pinKeys.length;
  stats.textContent = `${n.toLocaleString()} pinned video${n === 1 ? "" : "s"}`;
  clearBtn.disabled = n === 0;
}

async function load() {
  let all = {};
  try {
    all = await api.storage.local.get(null);
  } catch {
    /* ignore */
  }
  render(all[ENABLED_KEY] !== false);
  pinKeys = Object.keys(all).filter((k) => k.startsWith(PIN_PREFIX));
  renderStats();
}

function resetClearButton() {
  clearTimeout(confirmTimer);
  confirmTimer = null;
  clearBtn.classList.remove("confirm");
  clearBtn.textContent = "Clear pins";
}

toggle.addEventListener("change", async () => {
  const enabled = toggle.checked;
  render(enabled);
  // Turning off stops pinning new content; what is already on screen stays
  // until the tab reloads.
  hint.hidden = enabled;
  try {
    await api.storage.local.set({ [ENABLED_KEY]: enabled });
  } catch {
    /* ignore */
  }
});

// Two-step confirmation: confirm() is unreliable inside extension popups.
clearBtn.addEventListener("click", async () => {
  if (!confirmTimer) {
    clearBtn.classList.add("confirm");
    clearBtn.textContent = "Click again to clear";
    confirmTimer = setTimeout(resetClearButton, CONFIRM_MS);
    return;
  }
  resetClearButton();
  clearBtn.disabled = true;
  try {
    await api.storage.local.remove(pinKeys);
  } catch {
    /* ignore */
  }
  await load();
});

load();
