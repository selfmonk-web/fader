// Fader — Audio Controller Content Script
// Injected on-demand into tabs to control audio volume via Web Audio API GainNode

(function () {
  // Guard against double-injection
  if (window.__faderInjected) return;
  window.__faderInjected = true;

  // Store GainNode and AudioContext per media element to avoid re-wrapping
  const gainNodes = new WeakMap();
  const audioContexts = new WeakMap();

  // Current gain value (1.0 = 100%)
  let currentGain = 1.0;
  let currentlyMuted = false;
  let gainBeforeMute = 1.0;

  /**
   * Connect a single media element to the Web Audio API graph with a GainNode.
   * Returns the GainNode, or null if the element uses DRM (encrypted media).
   */
  const connectElement = (mediaEl) => {
    // Already connected
    if (gainNodes.has(mediaEl)) return gainNodes.get(mediaEl);

    try {
      // Create a fresh AudioContext for each element (or reuse if possible)
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(mediaEl);
      const gainNode = ctx.createGain();

      gainNode.gain.value = currentGain;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      gainNodes.set(mediaEl, gainNode);
      audioContexts.set(mediaEl, ctx);

      return gainNode;
    } catch (err) {
      // DRM content or already captured — mark as protected
      mediaEl.__faderDRM = true;
      return null;
    }
  };

  /**
   * Apply a gain value to all media elements on the page, including
   * elements inside iframes that share the same origin.
   */
  const applyGainToAll = (gain) => {
    currentGain = gain;

    // Collect all audio/video elements from the current document
    const elements = Array.from(document.querySelectorAll("audio, video"));

    // Also try to reach same-origin iframes
    try {
      const frames = Array.from(document.querySelectorAll("iframe"));
      for (const frame of frames) {
        try {
          const frameDoc = frame.contentDocument;
          if (frameDoc) {
            elements.push(...Array.from(frameDoc.querySelectorAll("audio, video")));
          }
        } catch (_) {
          // Cross-origin iframe — skip silently
        }
      }
    } catch (_) {}

    const results = { connected: 0, drm: 0 };

    for (const el of elements) {
      if (el.__faderDRM) {
        results.drm++;
        continue;
      }

      // Resume suspended AudioContext (browsers suspend on user gesture)
      const ctx = audioContexts.get(el);
      if (ctx && ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }

      const node = connectElement(el);
      if (node) {
        node.gain.value = gain;
        results.connected++;
      } else if (el.__faderDRM) {
        results.drm++;
      }
    }

    return results;
  };

  /**
   * Apply mute without losing the slider position.
   */
  const applyMute = (muted) => {
    currentlyMuted = muted;
    if (muted) {
      gainBeforeMute = currentGain;
      applyGainToAll(0);
    } else {
      applyGainToAll(gainBeforeMute);
    }
  };

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "SET_VOLUME") {
      const results = applyGainToAll(message.gain);
      currentlyMuted = false;
      sendResponse({ success: true, ...results });
      return true;
    }

    if (message.type === "SET_MUTE") {
      // If the content script was re-injected after mute (e.g. tab refreshed),
      // gainBeforeMute resets to 1.0. Use fallbackGain from popup to recover.
      if (!message.muted && message.fallbackGain != null) {
        gainBeforeMute = message.fallbackGain;
      }
      applyMute(message.muted);
      sendResponse({ success: true });
      return true;
    }

    if (message.type === "GET_STATE") {
      sendResponse({
        gain: currentGain,
        muted: currentlyMuted,
        hasDRM: Array.from(document.querySelectorAll("audio, video")).some(el => el.__faderDRM)
      });
      return true;
    }
  });

  // Watch for dynamically added media elements (e.g. Spotify lazy-loads audio)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const mediaEls = node.matches?.("audio, video")
          ? [node]
          : Array.from(node.querySelectorAll?.("audio, video") ?? []);

        for (const el of mediaEls) {
          if (!gainNodes.has(el) && !el.__faderDRM) {
            const node = connectElement(el);
            if (node) node.gain.value = currentGain;
          }
        }
      }
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
