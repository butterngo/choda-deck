// TASK-2756 — moved from companion/assistant-redact.ts (TASK-2734). What
// every assistant tool result passes through before it can
// reach a provider (ADR adr-when-this-project-may-call-a-model, 2026-10-24
// amendment). Butter's decision A in the discovery: the vault holds client
// infrastructure notes, so addresses and secret-naming lines are masked here,
// not left to the model's discretion.

/** IPv4 dotted quads, each octet 0-255. Not anchored: an address inside a URL counts. */
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g

/** A line that names a credential. The whole line goes, because the value may sit anywhere on it. */
const SECRET_LINE = /password|passwd|token|secret|api[-_ ]?key|connection ?string/i

export const CAP_CHARS = 16_000
export const TRUNCATED_MARKER = '\n[truncated]'

/** Mask IPv4 addresses as `[ip]` and replace every secret-naming line with `[line redacted]`. */
export function redact(text: string): string {
  return text
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === '\n' || part === '\r\n') return part
      if (SECRET_LINE.test(part)) return '[line redacted]'
      return part.replace(IPV4, '[ip]')
    })
    .join('')
}

/** Keep the first 16000 characters; mark anything cut. */
export function cap(text: string): string {
  return text.length > CAP_CHARS ? text.slice(0, CAP_CHARS) + TRUNCATED_MARKER : text
}

/**
 * TASK-2743 — redact every string VALUE inside a tool result, line by line,
 * before it is serialised. Redacting the serialised JSON instead was wrong:
 * JSON.stringify yields ONE line, so a single secret-naming word anywhere (a
 * task body mentioning x-choda-bridge-token) wiped the whole result, status
 * and all, and the model answered "UNKNOWN" (TASK-2731 smoke, 2026-10-24).
 * Keys are left alone: a field called tokenBudget names no secret.
 */
export function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]))
  }
  return value
}
