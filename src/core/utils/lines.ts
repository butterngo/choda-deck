/**
 * Split file content into lines, tolerant of LF (`\n`) and CRLF (`\r\n`).
 * Always use this instead of `content.split('\n')` for artifact/stdout parsing —
 * Windows-first ship target means CRLF endings show up routinely.
 * Origin: TASK-726 PR #95 (commit 50ac5ae) — strict `===` line match silently
 * failed on CRLF input. ADR-023 Fix 3 promotes the pattern.
 */
export function splitLines(content: string): string[] {
  return content.split(/\r?\n/)
}
