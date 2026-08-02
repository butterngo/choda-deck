// TASK-1555 — DevTools-style element picker. Hover highlights, click freezes, Escape
// cancels; the confirmed pick carries a stable selector, a curated computed-style
// subset, capped outerHTML, an ancestor chain, and the element's bounding rect (which
// the panel uses to crop the screenshot).
//
// This is a CAPTURE feature, not an editing one — you cannot persist a change to a site
// you do not own. What it produces is precise enough for Claude to fix the SOURCE, which
// is why the selector must stay source-greppable.
//
// The overlay renders in a CLOSED shadow root and never mutates page styles. A picker
// that restyled the page to describe it would corrupt the very thing being reported.
// Runs in the isolated world; extension/inject.js (MAIN world) already carries a known
// console-attribution defect (INBOX-1641) and this deliberately does not add to it.
//
// Dual-mode (globalThis + module.exports), no import/export — valid MV3 classic script.

;(function (root) {
  const selectorApi = root.ChodaSelector || (typeof require !== 'undefined' && require('./selector.js'))

  const MAX_OUTER_HTML = 8 * 1024
  const MAX_ANCESTORS = 4
  const OVERLAY_ID = 'choda-picker-overlay'

  // The layout-relevant subset. Asserted by a test so it cannot silently grow to all
  // ~340 computed properties — the point is a payload a reader can scan, and the full
  // dump would bury the three values that actually explain a broken element.
  const CAPTURED_PROPS = [
    'display', 'position', 'width', 'height', 'padding', 'margin', 'border',
    'boxSizing', 'flexDirection', 'justifyContent', 'alignItems', 'gap',
    'gridTemplateColumns', 'gridTemplateRows',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
    'color', 'backgroundColor', 'borderRadius', 'boxShadow', 'opacity',
    'overflow', 'whiteSpace', 'textOverflow', 'zIndex', 'visibility'
  ]

  function tagOf(el) {
    return ((el && el.tagName) || '').toLowerCase()
  }

  // Landmarks worth anchoring a path to. A selector rooted at the nearest one survives a
  // wrapper <div> being inserted higher up; a path walked all the way to <body> does not.
  const LANDMARK_TAGS = new Set(['main', 'nav', 'aside', 'header', 'footer', 'article', 'section', 'form', 'dialog', 'table'])

  // Classes that carry no identity. Utility frameworks generate these in bulk, and a
  // selector built from them is neither unique nor meaningful. Matched as whole classes.
  const UTILITY_CLASS =
    /^(?:[a-z]+-\d+|[pmwh][xytblr]?-\d+|flex|grid|block|inline(?:-\w+)?|hidden|relative|absolute|fixed|sticky|static|box-\w+|items-\w+|justify-\w+|self-\w+|text-\w+|bg-\w+|border(?:-\w+)?|rounded(?:-\w+)?|shadow(?:-\w+)?|gap-\w+|space-\w+|overflow-\w+|font-\w+|leading-\w+|tracking-\w+|opacity-\d+|z-\d+|w-\w+|h-\w+|min-\w+|max-\w+|transition(?:-\w+)?|duration-\d+|ease-\w+|cursor-\w+|select-\w+|whitespace-\w+|truncate|sr-only|container|group|peer)$/

  function isUtilityClass(c) {
    return UTILITY_CLASS.test(c)
  }

  /** Classes that plausibly name a component rather than a style utility. */
  function semanticClasses(el) {
    return String((el && el.getAttribute && el.getAttribute('class')) || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !isUtilityClass(c) && !/^[a-z]$/.test(c))
  }

  function hasStableAttr(el) {
    if (!el || !el.getAttribute) return false
    return Boolean(el.getAttribute('data-testid') || el.id || el.getAttribute('aria-label'))
  }

  /**
   * How findable this selector is in a repo — the whole point of the picker is Claude
   * fixing the SOURCE, and a positional path cannot be grepped for.
   *
   * `semantic`   — anchored on data-testid / id / aria-label. Grep it directly.
   * `class`      — anchored on a non-utility class. Usually greppable.
   * `positional` — nth-of-type only. Correct, but tells a reader nothing about where the
   *                code lives. Observed live on a Tailwind page, where EVERY pick lands
   *                here: `body > div:nth-of-type(5) > … > span:nth-of-type(1)`.
   *
   * Reported so a positional selector cannot pass for a semantic one in the artifact —
   * the same false-confidence failure TASK-1549/1551 exist to prevent.
   */
  function selectorQuality(el) {
    if (hasStableAttr(el)) return 'semantic'
    let node = el && el.parentElement
    while (node && tagOf(node) !== 'html') {
      if (hasStableAttr(node)) return 'semantic'
      node = node.parentElement
    }
    if (semanticClasses(el).length) return 'class'
    return 'positional'
  }

  /**
   * Shorten a fallback path by rooting it at the nearest landmark ancestor, when doing so
   * still resolves uniquely. Verified against the live document before being returned —
   * a shorter selector that matches two elements is worse than a long one that matches
   * one, so this never trades correctness for brevity.
   */
  function shortenPath(el, fullPath) {
    const doc = el && el.ownerDocument
    if (!doc || typeof doc.querySelectorAll !== 'function') return fullPath

    const segments = []
    let node = el
    while (node && tagOf(node) !== 'html' && tagOf(node) !== 'body') {
      const cls = semanticClasses(node)
      const own = cls.length
        ? `${tagOf(node)}.${cls.slice(0, 2).map(cssEscapeLocal).join('.')}`
        : `${tagOf(node)}:nth-of-type(${nthOfTypeLocal(node)})`
      segments.unshift(own)

      // Try this suffix on its own, and rooted at a landmark, shortest first.
      const candidate = segments.join(' > ')
      if (resolvesUniquely(doc, candidate, el)) return candidate
      if (LANDMARK_TAGS.has(tagOf(node.parentElement))) {
        const anchored = `${tagOf(node.parentElement)} > ${candidate}`
        if (resolvesUniquely(doc, anchored, el)) return anchored
      }
      node = node.parentElement
    }
    return fullPath
  }

  function resolvesUniquely(doc, selector, el) {
    try {
      const hits = doc.querySelectorAll(selector)
      return hits.length === 1 && hits[0] === el
    } catch {
      return false
    }
  }

  function cssEscapeLocal(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s)
    return String(s).replace(/["\\\]#.:]/g, '\\$&')
  }

  function nthOfTypeLocal(el) {
    let i = 1
    let sib = el.previousElementSibling
    while (sib) {
      if (sib.tagName === el.tagName) i++
      sib = sib.previousElementSibling
    }
    return i
  }

  /** A short human label — `button.btn.btn--primary#submit`. */
  function describe(el) {
    if (!el || !el.tagName) return ''
    const id = el.id ? `#${el.id}` : ''
    const cls = String(el.getAttribute?.('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join('')
    return `${tagOf(el)}${id}${cls}`
  }

  function cap(str, max) {
    const s = String(str || '')
    if (s.length <= max) return s
    return s.slice(0, max) + `\n<!-- choda: truncated at ${max} bytes -->`
  }

  /** The curated computed-style subset, as plain strings. */
  function captureStyles(el, view) {
    const w = view || (el && el.ownerDocument && el.ownerDocument.defaultView)
    if (!w || typeof w.getComputedStyle !== 'function') return {}
    let cs
    try {
      cs = w.getComputedStyle(el)
    } catch {
      return {}
    }
    const out = {}
    for (const prop of CAPTURED_PROPS) {
      const value = cs[prop]
      if (typeof value === 'string' && value !== '') out[prop] = value
    }
    return out
  }

  /** Ancestor chain as short labels, nearest first — context without the whole tree. */
  function ancestorChain(el, limit) {
    const max = typeof limit === 'number' ? limit : MAX_ANCESTORS
    const chain = []
    let node = el && el.parentElement
    while (node && chain.length < max && tagOf(node) !== 'html') {
      chain.push(describe(node))
      node = node.parentElement
    }
    return chain
  }

  function rectOf(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height)
    }
  }

  /**
   * Build the payload for one picked element.
   *
   * `sourceUrl` is stamped HERE, at pick time — not read at send. A user can pick, then
   * navigate, then hit Send; reading the tab at send would name the wrong page. This is
   * the TASK-1551 rule, and the reason the panel keeps a pendingPick rather than
   * re-deriving anything later.
   */
  function buildPick(el, opts) {
    const options = opts || {}
    if (!el || !el.tagName) return null
    const quality = selectorQuality(el)
    const raw = selectorApi.cssPath(el)
    // Only a positional path is worth shortening; a semantic one is already short and
    // already greppable, and rewriting it would lose the very anchor that makes it good.
    const selector = quality === 'semantic' ? raw : shortenPath(el, raw)
    return {
      selector,
      selectorQuality: quality,
      label: describe(el),
      tag: tagOf(el),
      rect: rectOf(el),
      styles: captureStyles(el, options.window),
      parentStyles: el.parentElement ? captureStyles(el.parentElement, options.window) : {},
      ancestors: ancestorChain(el),
      outerHTML: cap(el.outerHTML, options.maxHtml || MAX_OUTER_HTML),
      // Stamped at capture, never re-read at send (TASK-1551).
      sourceUrl: options.sourceUrl || (el.ownerDocument && el.ownerDocument.location
        ? el.ownerDocument.location.href
        : '')
    }
  }

  /** Render a pick as the markdown that reaches Claude. */
  function formatPick(pick, note) {
    if (!pick) return ''
    const styleBlock = (title, styles) => {
      const rows = Object.entries(styles || {})
      if (!rows.length) return ''
      return `\n**${title}**\n\n\`\`\`css\n${rows.map(([k, v]) => `${k}: ${v};`).join('\n')}\n\`\`\`\n`
    }
    const out = [`**Element:** \`${pick.label}\``, `**Selector:** \`${pick.selector}\``]
    // Say plainly when the selector cannot be grepped for. Without this a positional
    // path reads as authoritative as a data-testid, and whoever picks up the artifact
    // wastes time searching the repo for a string that was never in it.
    if (pick.selectorQuality === 'positional') {
      out.push(
        '**⚠ Positional selector** — this element has no `data-testid`, `id`, `aria-label`' +
          ' or meaningful class, so the selector describes WHERE it sits, not WHAT it is.' +
          ' It will not be found by searching the source, and it breaks if the markup' +
          ' shifts. Identify the component from the HTML and styles below instead.'
      )
    } else if (pick.selectorQuality === 'class') {
      out.push('_Selector anchored on a class name — greppable, but not guaranteed unique in source._')
    }
    if (pick.rect) out.push(`**Size:** ${pick.rect.width}×${pick.rect.height} at (${pick.rect.x}, ${pick.rect.y})`)
    if (pick.ancestors.length) out.push(`**Inside:** ${pick.ancestors.map((a) => `\`${a}\``).join(' ← ')}`)
    let body = out.join('\n')
    body += styleBlock('Computed', pick.styles)
    body += styleBlock('Parent', pick.parentStyles)
    body += `\n**HTML**\n\n\`\`\`html\n${pick.outerHTML}\n\`\`\`\n`
    if (note && note.trim()) body += `\n**What's wrong**\n\n${note.trim()}\n`
    return body
  }

  /**
   * Activate the picker on `doc`. Returns a handle with cancel().
   *
   * onPick(pick) fires on click; onCancel() on Escape. Both stop the picker first, so a
   * handler is free to open a dialog without the overlay still tracking the pointer.
   */
  function startPicker(doc, handlers) {
    const on = handlers || {}
    if (!doc || !doc.body) return { cancel() {}, active: false }

    const host = doc.createElement('div')
    host.id = OVERLAY_ID
    // Inline styles on the HOST only — this element is ours, so styling it changes
    // nothing of the page's. Everything else lives inside the shadow root.
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none'
    // closed: the page cannot reach in and read or restyle the overlay.
    const shadow = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : null
    const box = doc.createElement('div')
    box.setAttribute('part', 'box')
    box.style.cssText =
      'position:fixed;border:2px solid #FF7759;background:rgba(255,119,89,0.12);pointer-events:none;box-sizing:border-box'
    const badge = doc.createElement('div')
    badge.style.cssText =
      'position:fixed;padding:2px 6px;font:11px/1.4 monospace;background:#1B1B1B;color:#fff;pointer-events:none;white-space:nowrap'
    if (shadow) {
      shadow.appendChild(box)
      shadow.appendChild(badge)
    }
    doc.body.appendChild(host)

    let current = null
    let stopped = false

    function paint(el) {
      const r = rectOf(el)
      if (!r) return
      box.style.left = `${r.x}px`
      box.style.top = `${r.y}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
      badge.textContent = `${describe(el)}  ${r.width}×${r.height}`
      // Above the element when there is room, otherwise just inside its top edge.
      badge.style.left = `${r.x}px`
      badge.style.top = r.y > 20 ? `${r.y - 20}px` : `${r.y}px`
    }

    function onMove(e) {
      const el = e.target
      if (!el || el === host || !el.tagName) return
      current = el
      paint(el)
    }

    function onClick(e) {
      // Capture phase + preventDefault: a click on a link or submit button must not
      // navigate the page out from under the pick.
      e.preventDefault()
      e.stopPropagation()
      const el = current || e.target
      stop()
      if (typeof on.onPick === 'function') on.onPick(buildPick(el, { window: doc.defaultView }))
    }

    function onKey(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      stop()
      if (typeof on.onCancel === 'function') on.onCancel()
    }

    function stop() {
      if (stopped) return
      stopped = true
      doc.removeEventListener('mousemove', onMove, true)
      doc.removeEventListener('click', onClick, true)
      doc.removeEventListener('keydown', onKey, true)
      if (host.parentNode) host.parentNode.removeChild(host)
    }

    doc.addEventListener('mousemove', onMove, true)
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('keydown', onKey, true)

    return {
      cancel: stop,
      get active() {
        return !stopped
      }
    }
  }

  /**
   * Map a CSS-pixel rect onto the captured screenshot's device pixels, clamped to the
   * image. captureVisibleTab returns a DPR-scaled bitmap, so a 2x display makes every
   * coordinate double — cropping with raw CSS pixels silently yields the top-left
   * quarter of the element on a retina screen and looks plausible enough to ship.
   *
   * Returns null when the rect lies entirely outside the image or has no area: a
   * zero-size crop throws in canvas, and an off-screen element genuinely has no pixels.
   */
  function cropRect(rect, dpr, imageWidth, imageHeight) {
    if (!rect || !Number.isFinite(imageWidth) || !Number.isFinite(imageHeight)) return null
    const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
    const left = Math.max(0, Math.round(rect.x * scale))
    const top = Math.max(0, Math.round(rect.y * scale))
    const right = Math.min(imageWidth, Math.round((rect.x + rect.width) * scale))
    const bottom = Math.min(imageHeight, Math.round((rect.y + rect.height) * scale))
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) return null
    return { x: left, y: top, width, height }
  }

  const api = {
    startPicker,
    cropRect,
    selectorQuality,
    shortenPath,
    semanticClasses,
    isUtilityClass,
    LANDMARK_TAGS,
    buildPick,
    formatPick,
    captureStyles,
    ancestorChain,
    describe,
    rectOf,
    CAPTURED_PROPS,
    MAX_OUTER_HTML,
    OVERLAY_ID
  }
  root.ChodaPicker = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
