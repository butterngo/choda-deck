// TASK-1413 — per-step DOM snapshotter. Captures a full snapshot at MEANINGFUL
// moments only (nav + page-changing click), NOT a continuous mutation stream —
// deliberate scope cut (snapshot-per-step, no video replay). Emits `snapshot`
// timeline events referencing a DiscoverySnapshot carried in the bundle.
//
// Size strategy (AC-3): html + css are capped so a single snapshot stays well
// under ~1 MB, keeping N snapshots inside the 5 MB session bundle cap. Screenshots
// are captured out-of-band by the SW (chrome.tabs.captureVisibleTab as JPEG q60 —
// see background.js) because content scripts can't call captureVisibleTab; the SW
// keeps them small so the image never dominates the budget.
//
// Dual-mode (globalThis + module.exports), no import/export — valid classic script.

;(function (root) {
  const redact = root.ChodaRedact || (typeof require !== 'undefined' && require('./redact.js'))

  const MAX_HTML_BYTES = 900 * 1024
  const MAX_CSS_BYTES = 100 * 1024

  // Snapshot on navigation and on clicks (which usually change the view); never on
  // high-frequency input/change/scroll. The caller additionally debounces.
  function shouldSnapshot(eventType) {
    return eventType === 'nav' || eventType === 'click'
  }

  function cap(str, max) {
    if (typeof str !== 'string') return ''
    if (str.length <= max) return str
    return str.slice(0, max) + '\n<!-- choda: truncated at ' + max + ' bytes -->'
  }

  // Concatenate same-origin stylesheet rules; cross-origin sheets throw on
  // cssRules access — skip them.
  function collectCss(doc) {
    const sheets = (doc && doc.styleSheets) || []
    const out = []
    for (const sheet of Array.from(sheets)) {
      try {
        const rules = sheet.cssRules || []
        for (const rule of Array.from(rules)) out.push(rule.cssText)
      } catch {
        /* cross-origin stylesheet — not readable */
      }
    }
    return out.join('\n')
  }

  function serializeDom(doc) {
    const rawHtml = doc && doc.documentElement ? doc.documentElement.outerHTML : ''
    const html = cap(redact.redactText(rawHtml), MAX_HTML_BYTES)
    const css = cap(redact.redactText(collectCss(doc)), MAX_CSS_BYTES)
    return { html, css }
  }

  // Build a snapshot record + the `snapshot` timeline event that references it.
  // screenshotDataUrl is supplied by the caller (from the SW) or omitted.
  function takeSnapshot(opts) {
    const doc = opts.doc
    const id = opts.id
    const ts = opts.now ? opts.now() : Date.now()
    const { html, css } = serializeDom(doc)
    const snapshot = { id, html, css }
    if (typeof opts.screenshotDataUrl === 'string') snapshot.screenshotDataUrl = opts.screenshotDataUrl
    const event = { type: 'snapshot', ts, url: doc && doc.location ? doc.location.href : opts.url, snapshotId: id }
    return { snapshot, event }
  }

  const api = { shouldSnapshot, serializeDom, takeSnapshot, MAX_HTML_BYTES, MAX_CSS_BYTES }
  root.ChodaSnapshot = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
