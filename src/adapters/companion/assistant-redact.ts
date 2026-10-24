// TASK-2734 — what every assistant tool result passes through before it can
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
