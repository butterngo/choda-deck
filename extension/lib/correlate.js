// Choda Capture — matching a relayed body to the webRequest record it belongs to.
//
// The two sides see different halves of a request and share no id: chrome.webRequest
// has a requestId but no body, the MAIN-world fetch/XHR patch has the body but no
// way to learn Chrome's requestId. So correlation is by (url, method) plus the time
// the page started the call — NOT by "newest record lacking a body", which mixes up
// concurrent identical requests (a page fetching the same endpoint 3x is ordinary).
//
// Dual-mode: assigns to globalThis (background.js importScripts) and module.exports
// (vitest). No import/export keywords — those would break the classic-script load.

;(function (root) {
  // Widest gap tolerated between the page-side call and the webRequest record it's
  // matched to. Generous — the two clocks are the same epoch and only queueing sits
  // between them — but bounded, so a body can't attach to an unrelated older call.
  const MAX_SKEW_MS = 5000

  /**
   * @param records array of webRequest records ({url, method, ts, body})
   * @param msg relayed body message ({url, method, startedAt})
   * @returns the record to attach to, or null when nothing plausibly matches
   */
  function pickRecordForBody(records, msg) {
    if (!msg || typeof msg.url !== 'string') return null
    const candidates = records.filter(
      (r) =>
        r.url === msg.url &&
        (!msg.method || r.method === msg.method) &&
        r.body === undefined
    )
    if (!candidates.length) return null

    // No timestamp (older relay, or a path that couldn't stamp one) — fall back to
    // the oldest unclaimed record. FIFO beats newest-first: responses to identical
    // requests usually complete in start order, so the oldest pending is the better
    // guess, and it can't strand the first request permanently empty.
    if (typeof msg.startedAt !== 'number') {
      return candidates.reduce((best, r) => (r.ts < best.ts ? r : best))
    }

    let best = null
    let bestSkew = Infinity
    for (const r of candidates) {
      const skew = Math.abs(r.ts - msg.startedAt)
      if (skew < bestSkew) {
        best = r
        bestSkew = skew
      }
    }
    return bestSkew <= MAX_SKEW_MS ? best : null
  }

  const api = { pickRecordForBody, MAX_SKEW_MS }
  root.ChodaCorrelate = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
