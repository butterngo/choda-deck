// Choda Capture — request-list filtering for the Network panel.
//
// Four filters compose: type chip, method, status class, free-text search. Kept
// here (pure, testable) because the counting bug that motivated this module was
// invisible in popup.js: the chips counted by type ALONE while the list applied
// all four, so "API 25" could sit above a list of 9.
//
// Dual-mode: assigns to globalThis (popup.html classic script) and module.exports
// (vitest). No import/export keywords.

;(function (root) {
  // 2xx/3xx/4xx/5xx bucket; null for a status never captured or out of range.
  function statusClass(status) {
    const n = Number(status)
    if (!Number.isFinite(n) || n < 100 || n > 599) return null
    return `${Math.floor(n / 100)}xx`
  }

  // Search matches the URL always, and the response body when one was captured.
  function matchesSearch(r, query) {
    if (!query) return true
    const q = query.toLowerCase()
    if ((r.url || '').toLowerCase().includes(q)) return true
    return typeof r.body === 'string' && r.body.toLowerCase().includes(q)
  }

  function matchesType(r, type) {
    return !type || type === 'all' || (r.resType || 'api') === type
  }

  // Everything except the type chip — the counting path needs these alone.
  function matchesNonType(r, f) {
    const { method = 'all', statusClass: sc = 'all', query = '' } = f || {}
    return (
      (method === 'all' || r.method === method) &&
      (sc === 'all' || statusClass(r.status) === sc) &&
      matchesSearch(r, query)
    )
  }

  function matches(r, f) {
    return matchesType(r, (f || {}).type) && matchesNonType(r, f)
  }

  /**
   * How many rows the given type chip would show under the CURRENT other filters —
   * i.e. what clicking that chip actually yields, not a raw total.
   */
  function countForType(records, type, f) {
    return records.filter((r) => matchesType(r, type) && matchesNonType(r, f)).length
  }

  // The type chips, in display order. Shared with the panel so the rendered chips
  // and the persisted-state validator can never disagree about what's valid.
  const FILTER_TYPES = ['all', 'api', 'html', 'js', 'css']
  const STATUS_CLASSES = ['all', '2xx', '3xx', '4xx', '5xx']
  const MAX_QUERY_CHARS = 200

  /**
   * Coerce a restored-from-storage filter state into something safe to apply.
   * Storage is untrusted input: it can hold a shape written by an older version,
   * a type chip that no longer exists, or hand-edited junk — none of which may
   * leave the panel stuck showing nothing with no obvious way back.
   */
  function sanitizeFilterState(raw) {
    const f = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const method =
      typeof f.method === 'string' && /^[A-Za-z]{1,20}$/.test(f.method) ? f.method : 'all'
    return {
      type: FILTER_TYPES.includes(f.type) ? f.type : 'all',
      method,
      statusClass: STATUS_CLASSES.includes(f.statusClass) ? f.statusClass : 'all',
      query: typeof f.query === 'string' ? f.query.slice(0, MAX_QUERY_CHARS) : ''
    }
  }

  const api = {
    statusClass,
    matchesSearch,
    matchesType,
    matchesNonType,
    matches,
    countForType,
    sanitizeFilterState,
    FILTER_TYPES,
    STATUS_CLASSES
  }
  root.ChodaReqFilter = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
