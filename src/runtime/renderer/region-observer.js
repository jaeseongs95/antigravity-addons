'use strict';

/**
 * Throttled DOM Region Observer with automatic per-plugin disposal.
 */

function createRegionObserver(doc, win) {
  const observersByPlugin = new Map(); // pluginId -> Set<{ disconnect }>

  function observeRegion(pluginId, selector, callback, { debounceMs = 50 } = {}) {
    if (typeof callback !== 'function') throw new Error('ERR_OBSERVER_CALLBACK_REQUIRED');
    const MutationObs = (win && win.MutationObserver) || globalThis.MutationObserver;
    let timer = null;
    let disconnected = false;
    let lastMatch = null;

    const checkNow = () => {
      if (disconnected) return;
      let el = null;
      try {
        el = typeof doc.querySelector === 'function' ? doc.querySelector(selector) : null;
      } catch (_e) {
        return;
      }
      if (el && el !== lastMatch) {
        lastMatch = el;
        try {
          callback(el);
        } catch (_err) {}
      } else if (!el) {
        lastMatch = null;
      }
    };

    checkNow();

    let mo = null;
    if (typeof MutationObs === 'function' && (doc.body || doc.documentElement)) {
      mo = new MutationObs(() => {
        if (disconnected) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(checkNow, debounceMs);
      });
      try {
        mo.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
      } catch (_e) {}
    }

    const handle = {
      disconnect() {
        disconnected = true;
        lastMatch = null;
        if (timer) clearTimeout(timer);
        if (mo && typeof mo.disconnect === 'function') {
          try {
            mo.disconnect();
          } catch (_e) {}
        }
        const ownerSet = observersByPlugin.get(pluginId);
        if (ownerSet) ownerSet.delete(handle);
      },
    };

    let set = observersByPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      observersByPlugin.set(pluginId, set);
    }
    set.add(handle);
    return handle;
  }

  function disposePluginObservers(pluginId) {
    const set = observersByPlugin.get(pluginId);
    if (!set) return;
    for (const h of set) h.disconnect();
    observersByPlugin.delete(pluginId);
  }

  return Object.freeze({
    observeRegion,
    disposePluginObservers,
  });
}

module.exports = {
  createRegionObserver,
};
