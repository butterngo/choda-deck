// TASK-3155 — server-side redaction of a network capture, applied at parse time
// for every destination. The server is the gate: an old extension build, or any
// client that skips the extension's own masking, still cannot get a credential
// written to disk or pushed to the remote (conversation messages sync under
// CHODA_BACKEND=sync since TASK-1136). Header NAMES and cookie NAMES are kept so
// a reader still sees what was present; only the values go.
//
// Patterns mirror extension/lib/redact.js so both ends agree on what a secret
// looks like.

import type { NetworkRecord } from './capture-artifacts'

export const REDACTED = '[redacted]'

const SENSITIVE_HEADER_RE =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i

// Secret SHAPES inside free text (bodies): bearer tokens, JWTs, and
// `token=…` / `"access_token":"…"` style assignments.
const TEXT_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  /\b(?:api[_-]?key|access[_-]?token|secret|token|password|pwd)\b["']?\s*[=:]\s*["']?[A-Za-z0-9._~+/-]{8,}=*["']?/gi
]

export function redactHeaderMap(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_RE.test(name) ? REDACTED : value
  }
  return out
}

export function redactText(text: string): string {
  let out = text
  for (const re of TEXT_PATTERNS) out = out.replace(re, REDACTED)
  return out
}

/** Pure: returns a new record with credential values masked; method/url/status untouched. */
export function redactNetworkRecord(record: NetworkRecord): NetworkRecord {
  const out: NetworkRecord = { ...record }
  if (record.requestHeaders) out.requestHeaders = redactHeaderMap(record.requestHeaders)
  if (record.responseHeaders) out.responseHeaders = redactHeaderMap(record.responseHeaders)
  if (record.cookies) {
    out.cookies = Object.fromEntries(Object.keys(record.cookies).map((k) => [k, REDACTED]))
  }
  if (record.body !== undefined) out.body = redactText(record.body)
  if (record.reqBody !== undefined) out.reqBody = redactText(record.reqBody)
  return out
}
