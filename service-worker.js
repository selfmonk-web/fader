// Fader — Background Service Worker v1.1
// Tracks audio tab state, handles injection requests, and auto-restores
// volume after a tab refresh — so the user never has to reopen the popup.

const STORAGE_KEY_PREFIX = "fader_gain_";
const MASTER_STORAGE_KEY = "fader_master";

// Tracks which tabs currently have the content script alive in memory.
// Cleared on tab refresh/navigate so we know to re-inject.
const injectedTabs = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────

const getOrigin = (url) => {
  try { return new URL(url).origin; } catch { return ""; }
};

/**
 * Inject the content script into a tab (if not already injected),
 * then send a SET_VOLUME message with the stored gain for that domain.
 * Called automatically after a tab finishes loading.
 */
const restoreGainForTab = async (tabId, url) => {
  // Skip internal Chrome pages — scripting API will throw on these
  if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return;

  const origin = getOrigin(url);
  if (!origin) return;

  // Look up saved gain for this domain
  const storageKey = STORAGE_KEY_PREFIX + origin;
  let savedGain, masterGain;
  try {
    const result = await chrome.storage.local.get([storageKey, MASTER_STORAGE_KEY]);
    savedGain  = result[storageKey];
    masterGain = result[MASTER_STORAGE_KEY] ?? 1.0;
  } catch { return; }

  // Nothing saved for this domain — nothing to restore
  if (savedGain == null) return;

  // Inject content script (idempotent — content script guards itself)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/audio-controller.js"]
    });
    injectedTabs.add(tabId);
  } catch {
    // Tab may not be scriptable (e.g. PDF viewer, store page) — skip silently
    return;
  }

  // Small delay to let the page's own audio elements initialize before we
  // try to connect them. 800ms is a safe default for most SPAs.
  await new Promise(resolve => setTimeout(resolve, 800));

  // Apply the stored gain × master gain
  const effectiveGain = savedGain * masterGain;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SET_VOLUME", gain: effectiveGain });
  } catch {
    // Content script not ready yet — not critical, user can open popup to retry
  }
};

// ── Tab lifecycle listeners ───────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Tab finished loading: clear injected state (page memory was wiped)
  // and attempt to restore saved gain automatically
  if (changeInfo.status === "complete" && tab.url) {
    injectedTabs.delete(tabId);
    restoreGainForTab(tabId, tab.url);
  }

  // Tab stopped playing audio: clear injected state so next play re-injects cleanly
  if (changeInfo.audible === false) {
    injectedTabs.delete(tabId);
  }

  // Notify popup (if open) that tab list may have changed
  chrome.runtime.sendMessage({ type: "TABS_CHANGED" }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  chrome.runtime.sendMessage({ type: "TABS_CHANGED" }).catch(() => {});
});

// ── Message handler (popup → background) ─────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "INJECT_CONTENT_SCRIPT") {
    const { tabId } = message;

    // Already injected in this page session — skip
    if (injectedTabs.has(tabId)) {
      sendResponse({ success: true, alreadyInjected: true });
      return true;
    }

    chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/audio-controller.js"]
    }).then(() => {
      injectedTabs.add(tabId);
      sendResponse({ success: true });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // Keep channel open for async sendResponse
  }
});
