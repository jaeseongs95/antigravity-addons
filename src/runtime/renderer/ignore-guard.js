'use strict';

/**
 * Shadow-DOM-aware Ignore & No-Translate Guard (FV4 / D-R4-8 / TC-025).
 *
 * - Safely uses `evt.composedPath()` when available (handles real ShadowRoot events
 *   as well as mock unit-test events that omit `composedPath`).
 * - Walks across ShadowRoot host boundaries (`node.parentNode || node.host`).
 */

function isNodeIgnored(node, extraNoTranslateAttributes = [], ignoreElements = []) {
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);
  const extraAttrs = Array.isArray(extraNoTranslateAttributes) ? extraNoTranslateAttributes : [];
  let cur = node;
  let guard = 0;
  while (cur && guard < 128) {
    guard++;
    if (ignoreSet.has(cur)) return true;
    if (typeof cur.getAttribute === 'function') {
      if (
        cur.getAttribute('translate') === 'no' ||
        cur.getAttribute('data-addon-host-no-translate') === 'true' ||
        cur.getAttribute('data-addon-host-slot') !== null
      ) {
        return true;
      }
      for (let i = 0; i < extraAttrs.length; i++) {
        const attrVal = cur.getAttribute(extraAttrs[i]);
        if (attrVal !== null && attrVal !== 'false') return true;
      }
    }
    if (cur.parentNode) {
      cur = cur.parentNode;
    } else if (cur.host) {
      cur = cur.host;
    } else {
      break;
    }
  }
  return false;
}

function isElementInsideIgnored(nodeOrEvent, { extraNoTranslateAttributes = [], ignoreElements = [] } = {}) {
  if (!nodeOrEvent) return false;
  const ignoreSet = new Set(Array.isArray(ignoreElements) ? ignoreElements : []);

  // R-5: Distinguish DOM nodes (e.g. <a>, <form>, <area>, <base> which have a `.target` property) from Events
  const isDomNode = typeof nodeOrEvent.nodeType === 'number';
  if (!isDomNode && typeof nodeOrEvent === 'object' && ('target' in nodeOrEvent || typeof nodeOrEvent.composedPath === 'function')) {
    const pathNodes =
      typeof nodeOrEvent.composedPath === 'function'
        ? nodeOrEvent.composedPath()
        : nodeOrEvent.target
          ? [nodeOrEvent.target]
          : [];
    for (let i = 0; i < pathNodes.length; i++) {
      const n = pathNodes[i];
      if (!n) continue;
      if (ignoreSet.has(n)) return true;
      if (isNodeIgnored(n, extraNoTranslateAttributes, ignoreElements)) return true;
    }
    return false;
  }

  return isNodeIgnored(nodeOrEvent, extraNoTranslateAttributes, ignoreElements);
}

module.exports = {
  isNodeIgnored,
  isElementInsideIgnored,
};
