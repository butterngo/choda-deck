// TASK-1411 — the non-negotiable safety primitive for the discovery recorder.
// A single source of masking rules, shared by the behavior recorder (input
// values) and the DOM snapshotter (tokens in HTML/attributes/headers). Redaction
// happens AT CAPTURE TIME in the page — before any event leaves the browser —
// never as a post-hoc cleanup (gotcha: secret-carrying-capture-kinds-are-local-only).
//
// Dual-mode: assigns to globalThis (so manifest classic content scripts can use
// `ChodaRedact.*`) and to module.exports (so vitest can require it). No
// import/export keywords — those would make it fail to parse as a classic script.

;(function (root) {
  const REDACTED = '[redacted]'
  const MAX_VALUE_CHARS = 512

  // Field name / autocomplete tokens that mark a value we must never emit.
  const SENSITIVE_NAME_RE =
    /pass(word|wd)|secret|cvv|cvc|csc|ssn|card|cc[-_]?(num|number|csc|exp|name)|creditcard|otp|pin/i

  // Read a property from a real DOM element OR a plain stub the tests pass.
  function prop(field, key) {
    if (!field) return ''
    const v = field[key]
    return typeof v === 'string' ? v : ''
  }

  // Mask the value of a form field. Password / hidden / card / cvv / ssn fields
  // → [redacted]; everything else returns its trimmed, capped value.
  function redactValue(field) {
    const type = prop(field, 'type').toLowerCase()
    const name = prop(field, 'name')
    const autocomplete = prop(field, 'autocomplete')
    const id = prop(field, 'id')
    if (type === 'password' || type === 'hidden') return REDACTED
    if (SENSITIVE_NAME_RE.test(`${name} ${autocomplete} ${id}`)) return REDACTED
    return prop(field, 'value').slice(0, MAX_VALUE_CHARS)
  }

  // Regex-mask common secret SHAPES inside surrounding text (used on DOM/attrs).
  const PATTERNS = [
    // Authorization / bearer tokens
    /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
    // JWT (three base64url segments)
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    // api key-ish assignments: token=..., api_key: "...", access_token=...
    /\b(?:api[_-]?key|access[_-]?token|secret|token|password|pwd)\b\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{8,}=*["']?/gi
  ]
  function redactText(str) {
    if (typeof str !== 'string' || str.length === 0) return str
    let out = str
    for (const re of PATTERNS) out = out.replace(re, REDACTED)
    return out
  }

  // Drop/mask auth-bearing headers case-insensitively.
  const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-api-key|x-auth-token|proxy-authorization)$/i
  function redactHeaders(headers) {
    const out = {}
    if (!headers || typeof headers !== 'object') return out
    for (const [k, v] of Object.entries(headers)) {
      out[k] = SENSITIVE_HEADER_RE.test(k) ? REDACTED : v
    }
    return out
  }

  const api = { redactValue, redactText, redactHeaders, REDACTED }
  root.ChodaRedact = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(typeof globalThis !== 'undefined' ? globalThis : self)
