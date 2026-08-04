// TASK-1412 — stable element selector for the behavior recorder. A click on
// "some button" is useless downstream; the selector must resolve to WHICH element
// and re-select it reliably. Preference: data-testid → id → aria-label → a
// structural nth-of-type path. Dual-mode (globalThis + module.exports), no
// import/export so it stays a valid MV3 classic content script.

;(function (root) {
  // Tags that can only appear once per document — indexing them says nothing.
  const UNIQUE_TAGS = new Set(['body', 'head', 'html'])

  function attrSelector(el) {
    const testid = el.getAttribute && el.getAttribute('data-testid')
    if (testid) return `[data-testid="${cssEscape(testid)}"]`
    if (el.id) return `#${cssEscape(el.id)}`
    const aria = el.getAttribute && el.getAttribute('aria-label')
    if (aria) return `${tag(el)}[aria-label="${cssEscape(aria)}"]`
    return null
  }

  function tag(el) {
    return (el.tagName || '').toLowerCase()
  }

  // Minimal CSS.escape fallback (happy-dom/browsers have CSS.escape, but the
  // isolated world may not expose it in every context).
  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
    return String(s).replace(/["\\\]#.:]/g, '\\$&')
  }

  // Index among same-tag siblings, 1-based (matches :nth-of-type).
  function nthOfType(el) {
    let i = 1
    let sib = el.previousElementSibling
    while (sib) {
      if (sib.tagName === el.tagName) i++
      sib = sib.previousElementSibling
    }
    return i
  }

  // Walk up to the nearest ancestor with a stable attr id, building an
  // :nth-of-type path from there down. Falls back to a full path to <html>.
  function cssPath(el) {
    // Never return '' — a click can land on the document/<html> root or a detached
    // node; an empty selector would make the backend reject the whole session
    // (TASK-1420). Fall back to the tag name, else 'unknown'.
    if (!el || !el.tagName) return 'unknown'
    const direct = attrSelector(el)
    if (direct) return direct

    const parts = []
    let node = el
    while (node && node.tagName && tag(node) !== 'html') {
      const anchored = attrSelector(node)
      if (anchored) {
        parts.unshift(anchored)
        return parts.join(' > ')
      }
      // body is unique in a document, so :nth-of-type(1) on it is pure noise — it was
      // showing up on every fallback path ("body:nth-of-type(1) > div:nth-of-type(5) …",
      // seen live 2026-08-02). Emit the bare tag instead.
      parts.unshift(UNIQUE_TAGS.has(tag(node)) ? tag(node) : `${tag(node)}:nth-of-type(${nthOfType(node)})`)
      node = node.parentElement
    }
    return parts.join(' > ') || tag(el) || 'unknown'
  }

  // Exported additively for picker.js's shortenPath, which must know whether a candidate
  // ancestor carries a real anchor before deciding to root a path there. cssPath's own
  // behaviour is unchanged, so the recorder (TASK-1412) is unaffected.
  const api = { cssPath, attrSelector }
  root.ChodaSelector = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
