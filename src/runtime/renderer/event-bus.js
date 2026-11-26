'use strict';

/**
 * Vendor-neutral Plugin Event Bus with Payload Sanitization & Auto-Dispose (v3.0.0 — SOLID #0).
 */

const { sanitizeBusPayload } = require('../../core/service-bus-policy');

function createEventBus({ reportPluginError = () => {} } = {}) {
  const listenersByTopic = new Map(); // topic -> Set<{ pluginId, handler, once }>

  function on(pluginId, topic, handler, { once = false } = {}) {
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('ERR_INVALID_EVENT_TOPIC');
    if (typeof handler !== 'function') throw new Error('ERR_INVALID_EVENT_HANDLER');
    const cleanTopic = topic.trim();
    let set = listenersByTopic.get(cleanTopic);
    if (!set) {
      set = new Set();
      listenersByTopic.set(cleanTopic, set);
    }
    const entry = { pluginId, handler, once: Boolean(once) };
    set.add(entry);
    return () => {
      set.delete(entry);
      if (set.size === 0) listenersByTopic.delete(cleanTopic);
    };
  }

  function once(pluginId, topic, handler) {
    return on(pluginId, topic, handler, { once: true });
  }

  function emit(pluginId, topic, payload) {
    if (typeof topic !== 'string' || !topic.trim()) throw new Error('ERR_INVALID_EVENT_TOPIC');
    const cleanTopic = topic.trim();
    const set = listenersByTopic.get(cleanTopic);
    if (!set || set.size === 0) return 0;
    const cleanPayload = payload === undefined ? undefined : sanitizeBusPayload(payload);
    const snapshot = Array.from(set);
    let delivered = 0;
    for (let i = 0; i < snapshot.length; i += 1) {
      const entry = snapshot[i];
      if (entry.once) set.delete(entry);
      delivered += 1;
      try {
        const ret = entry.handler(
          cleanPayload === undefined ? undefined : sanitizeBusPayload(cleanPayload),
          Object.freeze({ topic: cleanTopic, sourcePluginId: pluginId })
        );
        if (ret && typeof ret.then === 'function') {
          ret.catch((err) => reportPluginError(entry.pluginId, err && err.message ? err.message : String(err)));
        }
      } catch (err) {
        reportPluginError(entry.pluginId, err && err.message ? err.message : String(err));
      }
    }
    if (set.size === 0) listenersByTopic.delete(cleanTopic);
    return delivered;
  }

  function disposePlugin(pluginId) {
    for (const [topic, set] of Array.from(listenersByTopic.entries())) {
      for (const entry of Array.from(set)) {
        if (entry.pluginId === pluginId) set.delete(entry);
      }
      if (set.size === 0) listenersByTopic.delete(topic);
    }
  }

  return Object.freeze({
    on,
    once,
    emit,
    disposePlugin,
  });
}

module.exports = {
  createEventBus,
};
