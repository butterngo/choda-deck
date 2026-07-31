// TASK-1553 — one shared rendered-DOM traversal. Two consumers by design:
// readability.js (this task) and the design-token extractor (TASK-1554). A second
// hand-rolled walk would drift from this one — the skip set in particular, which is
// the part both consumers must agree on to produce comparable output.
//
// Iterative, not recursive: a deeply nested page (accordion trees, editor DOMs) can
// exceed the JS stack, and a content script that throws takes the whole isolated-world
// bundle down with it.
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  // Never yielded, never descended into. These carry no rendered prose: script/style
  // hold code, template holds inert markup, and the embedded-document tags belong to a
  // different document whose contents this walk has no business claiming.
  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'SVG',
    'CANVAS',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'AUDIO',
    'VIDEO',
    'MAP',
    'LINK',
    'META'
  ])

  function tagOf(el) {
    return ((el && el.tagName) || '').toUpperCase()
  }

  function isSkippedTag(el) {
    return SKIP_TAGS.has(tagOf(el))
  }

  /**
   * Pre-order DFS over element nodes under `rootEl`.
   *
   * `visit({ el, tag, depth })` may return the literal `false` to skip that element's
   * subtree while continuing the walk elsewhere — the mechanism readability.js uses to
   * prune a nav without abandoning the rest of the document. Any other return value
   * (including undefined) descends normally.
   *
   * opts.computed — when true, each visit also gets `computed`, the element's
   * CSSStyleDeclaration. Off by default: getComputedStyle forces layout, and on a large
   * page calling it per element is the difference between a walk that costs nothing and
   * one the user feels. TASK-1554 turns it on; readability.js does not need it.
   *
   * opts.includeRoot — whether `rootEl` itself is visited (default true).
   */
  function walk(rootEl, visit, opts) {
    if (!rootEl || typeof visit !== 'function') return 0
    const options = opts || {}
    const wantComputed = options.computed === true
    const view =
      options.window ||
      (rootEl.ownerDocument && rootEl.ownerDocument.defaultView) ||
      (typeof window !== 'undefined' ? window : null)

    let visited = 0
    // Each frame is [element, depth]. Children are pushed in reverse so the stack pops
    // them in document order — without that, output ordering silently reverses per level.
    const stack = []
    if (options.includeRoot === false) {
      pushChildren(rootEl, 0)
    } else {
      stack.push([rootEl, 0])
    }

    function pushChildren(el, depth) {
      const kids = el.children
      if (!kids) return
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1])
    }

    while (stack.length) {
      const [el, depth] = stack.pop()
      if (isSkippedTag(el)) continue

      const info = { el, tag: tagOf(el), depth }
      if (wantComputed && view && typeof view.getComputedStyle === 'function') {
        try {
          info.computed = view.getComputedStyle(el)
        } catch {
          /* detached node or a view that refuses — the walk continues without styles */
        }
      }

      visited++
      if (visit(info) === false) continue
      pushChildren(el, depth)
    }
    return visited
  }

  /**
   * Visible text length of a subtree, whitespace-collapsed. Used for scoring, so it
   * must be cheap and stable — textContent, not innerText: innerText triggers layout
   * and is absent in the happy-dom test environment, which would make every score
   * differ between test and browser.
   */
  function textLength(el) {
    if (!el) return 0
    const t = el.textContent || ''
    return t.replace(/\s+/g, ' ').trim().length
  }

  /** Combined text length of this element's <a> descendants. */
  function linkTextLength(el) {
    if (!el || !el.querySelectorAll) return 0
    let n = 0
    for (const a of Array.from(el.querySelectorAll('a'))) n += textLength(a)
    return n
  }

  /**
   * Fraction of an element's text that sits inside links, 0..1. The single most useful
   * boilerplate signal: a nav or footer link-column is nearly all link text, an article
   * paragraph is nearly none. An element with no text at all scores 0, not NaN — a
   * NaN here propagates silently through every downstream comparison.
   */
  function linkDensity(el) {
    const total = textLength(el)
    if (total === 0) return 0
    return Math.min(1, linkTextLength(el) / total)
  }

  const api = { walk, textLength, linkTextLength, linkDensity, isSkippedTag, tagOf, SKIP_TAGS }
  root.ChodaDomWalk = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
