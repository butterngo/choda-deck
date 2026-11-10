// Choda Capture — view-model helpers for the Network panel's detail tabs
// (Headers / Payload / Preview / Response / Cookies). Pure functions, no DOM,
// so vitest can require them.
//
// Dual-mode: assigns to globalThis (popup.html loads it as a classic script) and
// to module.exports (vitest). No import/export keywords — those would make it
// fail to parse as a classic script.

;(function (root) {
  // webRequest's [{ name, value }] list → a lower-cased name → value map (the shape
  // the server's isStringMap accepts). A repeated name is JOINED, never overwritten
  // (TASK-3157): set-cookie lines with '\n' — a comma is ambiguous because
  // `Expires=` dates contain one — and every other repeat with ', ' (RFC 9110 §5.3).
  function headersToObject(headers) {
    const out = {}
    for (const h of headers || []) {
      const name = h.name.toLowerCase()
      if (!(name in out)) {
        out[name] = h.value
        continue
      }
      out[name] += (name === 'set-cookie' ? '\n' : ', ') + h.value
    }
    return out
  }

  // The "General" block DevTools shows above the header sections. Only fields the
  // extension actually captures — webRequest gives us no remote address, and the
  // referrer policy is only present when the page happened to send the header.
  function generalRows(r) {
    if (!r) return []
    const rows = [
      ['Request URL', r.url],
      ['Request Method', r.method]
    ]
    if (r.status !== undefined && r.status !== null) rows.push(['Status Code', String(r.status)])
    const policy = (r.requestHeaders || {})['referrer-policy']
    if (policy) rows.push(['Referrer Policy', policy])
    return rows
  }

  // Raw view = the wire format, one "name: value" per line.
  function rawHeaderText(headers) {
    return Object.entries(headers || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }

  // Request-side `Cookie: a=1; b=2` → one row per pair. Values may themselves
  // contain '=' (base64, JWTs), so split on the FIRST '=' only.
  function parseRequestCookies(headers) {
    const raw = (headers || {}).cookie
    if (typeof raw !== 'string' || raw === '') return []
    return raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf('=')
        return i === -1
          ? { name: part, value: '' }
          : { name: part.slice(0, i), value: part.slice(i + 1) }
      })
  }

  // Response-side `Set-Cookie: sid=abc; Path=/; HttpOnly` → the pair plus its
  // attributes, one entry per line (headersToObject joins repeats with '\n').
  function parseResponseCookies(headers) {
    const raw = (headers || {})['set-cookie']
    if (typeof raw !== 'string' || raw === '') return []
    const out = []
    for (const line of raw.split('\n')) {
      const [pair, ...attrs] = line.split(';').map((p) => p.trim())
      const i = pair.indexOf('=')
      if (i === -1) continue
      out.push({
        name: pair.slice(0, i),
        value: pair.slice(i + 1),
        attributes: attrs.filter(Boolean)
      })
    }
    return out
  }

  const api = {
    headersToObject,
    generalRows,
    rawHeaderText,
    parseRequestCookies,
    parseResponseCookies
  }
  root.ChodaNetView = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
