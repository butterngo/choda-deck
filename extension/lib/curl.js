// Choda Capture — cURL rendering + JSON pretty-printing for the Network panel's
// request detail tabs. Pure string functions, no DOM, so vitest can require them.
//
// Dual-mode: assigns to globalThis (popup.html loads it as a classic script) and
// to module.exports (vitest). No import/export keywords — those would make it
// fail to parse as a classic script.

;(function (root) {
  // POSIX single-quoting: wrap in '…' and rewrite each embedded ' as '\''.
  // Safe for header values and JSON bodies alike — nothing inside '…' is
  // interpreted by the shell, so no other escaping is needed.
  function shellQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`
  }

  // Headers webRequest reports but curl derives itself — emitting them produces a
  // command that either duplicates or contradicts what curl sends.
  const SKIP_HEADERS = new Set(['host', 'content-length', 'connection'])

  // Render one captured request as a copy-pasteable curl command. Multi-line with
  // trailing backslashes, matching what DevTools' "Copy as cURL" produces.
  function buildCurl(r) {
    if (!r || !r.url) return ''
    const parts = [`curl ${shellQuote(r.url)}`]
    const method = (r.method || 'GET').toUpperCase()
    if (method !== 'GET') parts.push(`-X ${method}`)
    for (const [k, v] of Object.entries(r.requestHeaders || {})) {
      if (SKIP_HEADERS.has(k.toLowerCase())) continue
      parts.push(`-H ${shellQuote(`${k}: ${v}`)}`)
    }
    if (typeof r.reqBody === 'string' && r.reqBody !== '') {
      parts.push(`--data-raw ${shellQuote(r.reqBody)}`)
    }
    return parts.join(' \\\n  ')
  }

  // Pretty-print when the text parses as JSON, otherwise hand back the original
  // string untouched. Objects and arrays only — a bare "123" or "null" is valid
  // JSON but reformatting it gains nothing and hides that it was a raw body.
  function prettyJson(text) {
    if (typeof text !== 'string') return text
    const trimmed = text.trim()
    if (!/^[[{]/.test(trimmed)) return text
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2)
    } catch {
      return text
    }
  }

  const api = { shellQuote, buildCurl, prettyJson, SKIP_HEADERS }
  root.ChodaCurl = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
