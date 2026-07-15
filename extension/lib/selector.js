// TASK-1412 — stable element selector for the behavior recorder. A click on
// "some button" is useless downstream; the selector must resolve to WHICH element
// and re-select it reliably. Preference: data-testid → id → aria-label → a
// structural nth-of-type path. Dual-mode (globalThis + module.exports), no
// import/export so it stays a valid MV3 classic content script.

;(function (root) {
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
    if (!el || !el.tagName) return ''
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
      parts.unshift(`${tag(node)}:nth-of-type(${nthOfType(node)})`)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  const api = { cssPath }
  root.ChodaSelector = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
