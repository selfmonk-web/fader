// Fader — Popup Logic v1.1
// Renders audio tabs, manages sliders, communicates with content scripts

// ── Constants ──────────────────────────────────────────────────────────────

const DEBOUNCE_MS        = 16;
const BUYMEACOFFEE_URL   = "https://buymeacoffee.com/nightintel";
const STORAGE_KEY_PREFIX = "fader_gain_";
const MASTER_STORAGE_KEY = "fader_master";
const HELP_SEEN_KEY      = "fader_help_seen";
const CLIP_THRESHOLD     = 1.5;   // warn above 150%
const BOOST_THRESHOLD    = 1.0;   // orange badge above 100%

// ── State ──────────────────────────────────────────────────────────────────

let masterGain    = 1.0;           // 0.0 – 2.0
let allMuted      = false;         // global mute-all state
let tabStates     = new Map();     // tabId → { gain, muted }
let debounceTimers = new Map();    // key → timer id

// ── DOM refs ────────────────────────────────────────────────────────────────

const tabList      = document.getElementById("tab-list");
const emptyState   = document.getElementById("empty-state");
const tabListSec   = document.getElementById("tab-list-section");
const tabCountEl   = document.getElementById("tab-count");
const masterSlider = document.getElementById("master-slider");
const masterValue  = document.getElementById("master-value");
const btnResetAll  = document.getElementById("btn-reset-all");
const btnMuteAll   = document.getElementById("btn-mute-all");
const btnHelp      = document.getElementById("btn-help");
const btnHelpClose = document.getElementById("btn-help-close");
const helpPanel    = document.getElementById("help-panel");
const btnCoffee    = document.getElementById("btn-coffee");
const cardTemplate = document.getElementById("tab-card-template");

// ── Utilities ───────────────────────────────────────────────────────────────

const pct = (gain) => `${Math.round(gain * 100)}%`;

/**
 * Update range slider fill gradient.
 * Below 100% = accent color; above 100% = orange; above 150% = red.
 */
const updateSliderFill = (slider, value, max) => {
  const pctFill = (value / max) * 100;
  const gain    = value / 100;
  let   color   = "var(--accent)";
  if (gain > CLIP_THRESHOLD)  color = "#fa6d6d";
  else if (gain > BOOST_THRESHOLD) color = "#ffa03c";
  slider.style.background =
    `linear-gradient(to right, ${color} 0%, ${color} ${pctFill}%, var(--surface2) ${pctFill}%, var(--surface2) 100%)`;
};

/**
 * Update the value badge color class based on gain level.
 */
const updateBadgeColor = (badgeEl, gain) => {
  badgeEl.classList.remove("boost", "danger");
  if      (gain > CLIP_THRESHOLD)  badgeEl.classList.add("danger");
  else if (gain > BOOST_THRESHOLD) badgeEl.classList.add("boost");
};

/** Save a domain gain to storage */
const saveDomainGain = (origin, gain) => {
  if (!origin || origin === "null") return;
  chrome.storage.local.set({ [STORAGE_KEY_PREFIX + origin]: gain }).catch(() => {});
};

/** Load a domain gain from storage, returns null if not found */
const loadDomainGain = async (origin) => {
  if (!origin || origin === "null") return null;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_PREFIX + origin);
    return result[STORAGE_KEY_PREFIX + origin] ?? null;
  } catch { return null; }
};

/** Debounce: key can be tabId (number) or a string for master_ prefixed keys */
const debounce = (key, fn) => {
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => { debounceTimers.delete(key); fn(); }, DEBOUNCE_MS));
};

const getOrigin = (url) => { try { return new URL(url).origin; } catch { return ""; } };
const getHost   = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

// ── Status dot helpers ────────────────────────────────────────────────────

/**
 * Set the status dot on a card: "pending" | "ok" | "error"
 * "ok" triggers a brief flash animation to confirm delivery.
 */
const setDotStatus = (card, status) => {
  const dot = card.querySelector(".status-dot");
  if (!dot) return;
  dot.classList.remove("pending", "ok", "error", "flash");
  dot.classList.add(status);
  if (status === "ok") {
    // Force reflow so animation re-triggers even on repeated ok
    void dot.offsetWidth;
    dot.classList.add("flash");
  }
  // Update tooltip
  const titles = { pending: "Connecting…", ok: "Applied ✓", error: "Could not reach tab" };
  dot.title = titles[status] ?? "";
};

// ── Content script injection ──────────────────────────────────────────────

/** Ask the background to inject content script; returns true on success. */
const ensureContentScript = async (tabId) => {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "INJECT_CONTENT_SCRIPT", tabId });
    return resp?.success ?? false;
  } catch { return false; }
};

/** Send SET_VOLUME to tab; returns true if acknowledged. */
const sendVolumeToTab = async (tabId, gain) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "SET_VOLUME", gain });
    return true;
  } catch { return false; }
};

/** Send SET_MUTE to tab. fallbackGain is sent on unmute so the content script
 *  can restore the correct level even if it was re-injected after the mute. */
const sendMuteToTab = async (tabId, muted, fallbackGain) => {
  try { await chrome.tabs.sendMessage(tabId, { type: "SET_MUTE", muted, fallbackGain }); } catch {}
};

// ── Card rendering ────────────────────────────────────────────────────────

const createTabCard = (tab, savedGain) => {
  const clone = cardTemplate.content.cloneNode(true);
  const card  = clone.querySelector(".tab-card");

  card.dataset.tabId = tab.id;

  // Favicon
  const favicon = card.querySelector(".tab-favicon");
  if (tab.favIconUrl) {
    favicon.src = tab.favIconUrl;
    favicon.onerror = () => { favicon.src = ""; favicon.classList.add("missing"); };
  } else {
    favicon.classList.add("missing");
  }

  card.querySelector(".tab-title").textContent  = tab.title || "Unknown tab";
  card.querySelector(".tab-origin").textContent = getHost(tab.url);

  const sliderEl   = card.querySelector(".tab-slider");
  const valueEl    = card.querySelector(".tab-value");
  const muteBtn    = card.querySelector(".mute-btn");
  const drmBadge   = card.querySelector(".drm-badge");
  const iconSound  = card.querySelector(".icon-sound");
  const iconMuted  = card.querySelector(".icon-muted");
  const clipWarn   = card.querySelector(".clip-warning");

  const initGain = savedGain !== null ? savedGain : 1.0;
  sliderEl.value       = Math.round(initGain * 100);
  valueEl.textContent  = pct(initGain);
  updateSliderFill(sliderEl, sliderEl.value, sliderEl.max);
  updateBadgeColor(valueEl, initGain);

  tabStates.set(tab.id, { gain: initGain, muted: false });

  // Apply saved gain immediately on open
  if (savedGain !== null) {
    setDotStatus(card, "pending");
    ensureContentScript(tab.id).then(async (ok) => {
      if (!ok) { setDotStatus(card, "error"); return; }
      const sent = await sendVolumeToTab(tab.id, initGain * masterGain);
      setDotStatus(card, sent ? "ok" : "error");
    });
  }

  // ── Slider input ──
  sliderEl.addEventListener("input", () => {
    const rawGain = sliderEl.value / 100;
    valueEl.textContent = pct(rawGain);
    updateSliderFill(sliderEl, sliderEl.value, sliderEl.max);
    updateBadgeColor(valueEl, rawGain);

    // Show/hide clip warning
    if (rawGain > CLIP_THRESHOLD) clipWarn.classList.remove("hidden");
    else clipWarn.classList.add("hidden");

    const state = tabStates.get(tab.id) ?? {};
    state.gain  = rawGain;
    state.muted = false;
    tabStates.set(tab.id, state);
    card.classList.remove("muted");
    iconSound.classList.remove("hidden");
    iconMuted.classList.add("hidden");

    setDotStatus(card, "pending");

    debounce(tab.id, async () => {
      const ok = await ensureContentScript(tab.id);
      if (!ok) { setDotStatus(card, "error"); return; }
      const sent = await sendVolumeToTab(tab.id, rawGain * masterGain);
      setDotStatus(card, sent ? "ok" : "error");
      if (sent) saveDomainGain(getOrigin(tab.url), rawGain);
    });
  });

  // ── Mute button ──
  muteBtn.addEventListener("click", async () => {
    const state = tabStates.get(tab.id) ?? { gain: 1, muted: false };
    state.muted = !state.muted;
    tabStates.set(tab.id, state);

    if (state.muted) {
      card.classList.add("muted");
      iconSound.classList.add("hidden");
      iconMuted.classList.remove("hidden");
    } else {
      card.classList.remove("muted");
      iconSound.classList.remove("hidden");
      iconMuted.classList.add("hidden");
    }

    setDotStatus(card, "pending");
    const ok = await ensureContentScript(tab.id);
    if (ok) {
      // Always pass current gain so content script can unmute to correct level
      // even if it was re-injected (and lost its gainBeforeMute) in the meantime
      await sendMuteToTab(tab.id, state.muted, state.gain * masterGain);
      setDotStatus(card, "ok");
    } else {
      setDotStatus(card, "error");
    }
  });

  // ── DRM detection ping (after 600ms to let content script settle) ──
  setTimeout(async () => {
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_STATE" });
      if (resp?.hasDRM) {
        drmBadge.classList.remove("hidden");
        sliderEl.disabled = true;
        sliderEl.style.opacity = "0.3";
        muteBtn.disabled = true;
        setDotStatus(card, "error");
        card.querySelector(".status-dot").title = "DRM protected — volume cannot be changed";
      }
    } catch {}
  }, 600);

  return card;
};

// ── Main render ───────────────────────────────────────────────────────────

const renderTabs = async () => {
  let audibleTabs = [];
  try { audibleTabs = await chrome.tabs.query({ audible: true }); } catch { return; }

  // Remove stale cards
  const currentIds = new Set(audibleTabs.map(t => t.id));
  for (const card of tabList.querySelectorAll(".tab-card")) {
    const id = parseInt(card.dataset.tabId, 10);
    if (!currentIds.has(id)) { card.remove(); tabStates.delete(id); }
  }

  // Add new cards
  const renderedIds = new Set(
    Array.from(tabList.querySelectorAll(".tab-card")).map(c => parseInt(c.dataset.tabId, 10))
  );

  for (const tab of audibleTabs) {
    if (!tab.id || renderedIds.has(tab.id)) continue;
    if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;

    const savedGain = await loadDomainGain(getOrigin(tab.url));
    tabList.appendChild(createTabCard(tab, savedGain));
  }

  // Sync mute-all button visual state if all tabs are muted
  syncMuteAllButton();

  // Update count and empty state
  const count = tabList.querySelectorAll(".tab-card").length;
  tabCountEl.textContent = count > 0 ? count : "";
  tabCountEl.style.display = count > 0 ? "" : "none";
  emptyState.classList.toggle("hidden", count > 0);
  tabListSec.style.display = count > 0 ? "" : "none";
};

// ── Master slider ─────────────────────────────────────────────────────────

masterSlider.addEventListener("input", () => {
  masterGain = masterSlider.value / 100;
  masterValue.textContent = pct(masterGain);
  updateSliderFill(masterSlider, masterSlider.value, masterSlider.max);

  for (const [tabId, state] of tabStates.entries()) {
    if (state.muted || allMuted) continue;
    const effective = state.gain * masterGain;
    debounce(`master_${tabId}`, () => sendVolumeToTab(tabId, effective));
  }

  chrome.storage.local.set({ [MASTER_STORAGE_KEY]: masterGain }).catch(() => {});
});

// ── Mute all ──────────────────────────────────────────────────────────────

const syncMuteAllButton = () => {
  btnMuteAll.textContent = allMuted ? "Unmute all" : "Mute all";
  btnMuteAll.classList.toggle("active", allMuted);
};

btnMuteAll.addEventListener("click", async () => {
  allMuted = !allMuted;
  syncMuteAllButton();

  for (const [tabId] of tabStates.entries()) {
    const ok = await ensureContentScript(tabId);
    const state = tabStates.get(tabId) ?? { gain: 1 };
    if (ok) await sendMuteToTab(tabId, allMuted, state.gain * masterGain);

    // Update card UI to reflect mute state
    const card = tabList.querySelector(`.tab-card[data-tab-id="${tabId}"]`);
    if (!card) continue;
    const iconSound = card.querySelector(".icon-sound");
    const iconMuted = card.querySelector(".icon-muted");
    if (allMuted) {
      card.classList.add("muted");
      iconSound.classList.add("hidden");
      iconMuted.classList.remove("hidden");
    } else {
      card.classList.remove("muted");
      iconSound.classList.remove("hidden");
      iconMuted.classList.add("hidden");
    }
    // Also update per-tab state so individual mute knows where it stands
    state.muted = allMuted;
    tabStates.set(tabId, state);
  }
});

// ── Reset all ─────────────────────────────────────────────────────────────

btnResetAll.addEventListener("click", async () => {
  // Reset master
  masterGain = 1.0;
  masterSlider.value = 100;
  masterValue.textContent = "100%";
  updateSliderFill(masterSlider, 100, 200);
  chrome.storage.local.set({ [MASTER_STORAGE_KEY]: 1.0 }).catch(() => {});

  // Reset mute-all state
  allMuted = false;
  syncMuteAllButton();

  for (const card of tabList.querySelectorAll(".tab-card")) {
    const tabId   = parseInt(card.dataset.tabId, 10);
    const slider  = card.querySelector(".tab-slider");
    const value   = card.querySelector(".tab-value");
    const clipW   = card.querySelector(".clip-warning");

    slider.value       = 100;
    value.textContent  = "100%";
    updateSliderFill(slider, 100, 200);
    updateBadgeColor(value, 1.0);
    clipW.classList.add("hidden");
    card.classList.remove("muted");
    card.querySelector(".icon-sound").classList.remove("hidden");
    card.querySelector(".icon-muted").classList.add("hidden");

    tabStates.set(tabId, { gain: 1.0, muted: false });
    setDotStatus(card, "pending");

    try {
      const tab = await chrome.tabs.get(tabId);
      saveDomainGain(getOrigin(tab.url), 1.0);
    } catch {}

    const ok = await ensureContentScript(tabId);
    if (ok) {
      await sendVolumeToTab(tabId, 1.0);
      await sendMuteToTab(tabId, false, 1.0);
      setDotStatus(card, "ok");
    } else {
      setDotStatus(card, "error");
    }
  }
});

// ── Help panel ────────────────────────────────────────────────────────────

const openHelp  = () => helpPanel.classList.remove("hidden");
const closeHelp = () => {
  helpPanel.classList.add("hidden");
  // Mark as seen so it won't auto-open again
  chrome.storage.local.set({ [HELP_SEEN_KEY]: true }).catch(() => {});
};

btnHelp.addEventListener("click", () => helpPanel.classList.toggle("hidden"));
btnHelpClose.addEventListener("click", closeHelp);

// ── Buy Me a Coffee ───────────────────────────────────────────────────────

btnCoffee.addEventListener("click", () => {
  chrome.tabs.create({ url: BUYMEACOFFEE_URL }).catch(() => window.open(BUYMEACOFFEE_URL, "_blank"));
});

// ── Background tab change listener ────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TABS_CHANGED") renderTabs();
});

// ── Init ──────────────────────────────────────────────────────────────────

const init = async () => {
  // Restore master gain
  try {
    const result = await chrome.storage.local.get([MASTER_STORAGE_KEY, HELP_SEEN_KEY]);
    if (result[MASTER_STORAGE_KEY] != null) {
      masterGain             = result[MASTER_STORAGE_KEY];
      masterSlider.value     = Math.round(masterGain * 100);
      masterValue.textContent = pct(masterGain);
    }
    // Show help panel on first ever open
    if (!result[HELP_SEEN_KEY]) openHelp();
  } catch {}

  updateSliderFill(masterSlider, masterSlider.value, masterSlider.max);
  await renderTabs();
};

init();
