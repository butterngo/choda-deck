import { splitLines } from '../../utils/lines'
import {
  AcAlreadyCheckedError,
  AcIndexOutOfRangeError,
  BodyLockViolationError
} from './errors'

export interface CheckAcItemInput {
  taskId: string
  acIndex: number
  evidence: string
  workspaceId?: string
}

export interface CheckAcItemResult {
  taskId: string
  acIndex: number
  text: string
  evidence: string
  eventId: string
  sessionId: string
}

// ADR-029 channel 2 — narrow body-lock bypass for ticking a single AC checkbox.
// Pure helpers, no DB. The MCP tool composes these inside a transaction with
// the session_events INSERT (atomic in SqliteTaskService.checkAcItem).
//
// AC item = a list-marker line inside the `## Acceptance` section whose marker
// is `- [ ]` or `- [x]` (case-insensitive `x`). Indices are 0-based and refer
// to AC items, NOT to body lines.

export interface AcItemPosition {
  /** 0-based index into the full body's line array (post-splitLines). */
  bodyLineIndex: number
  /** Original line text, preserving leading whitespace + marker + content. */
  line: string
  /** Trimmed AC text (after the `- [x]`/`- [ ]` marker). */
  text: string
  /** True when currently checked (`- [x]`). */
  checked: boolean
  /** Character offset (in the original body string) of the `[` opening the marker. */
  bracketStart: number
}

const AC_LINE_RE = /^(\s*[-*]\s+)\[([ xX])\](\s+.*)$/

export function findAcItems(body: string): AcItemPosition[] {
  const lines = splitLines(body)
  const startIdx = lines.findIndex((l) => /^##\s+Acceptance\b/i.test(l))
  if (startIdx === -1) return []

  // Track character offsets so we can compute bracketStart against the original body.
  // splitLines drops the separator; reconstruct by walking the original body once.
  const lineOffsets = computeLineOffsets(body, lines.length)

  const items: AcItemPosition[] = []
  let inFence = false
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence && /^#{1,2}\s+/.test(line)) break

    const m = AC_LINE_RE.exec(line)
    if (!m || inFence) continue

    const prefix = m[1]
    const mark = m[2]
    const trailing = m[3]
    const bracketStart = lineOffsets[i] + prefix.length
    items.push({
      bodyLineIndex: i,
      line,
      text: trailing.trim(),
      checked: mark.toLowerCase() === 'x',
      bracketStart
    })
  }
  return items
}

export function findAcItem(body: string, index: number): AcItemPosition | null {
  const items = findAcItems(body)
  if (index < 0 || index >= items.length) return null
  return items[index]
}

export interface FlipAcCheckboxResult {
  newBody: string
  item: AcItemPosition
}

/**
 * Flip the AC checkbox at `index` from `[ ]` to `[x]`. Throws when the index
 * is out of range, when the item is already checked, or when the post-flip diff
 * touches anything other than the single ` ` → `x` character.
 *
 * The diff assertion is the safety net for ADR-029's "narrow contract": even if
 * future regex changes accidentally pick the wrong line, the body-lock bypass
 * stops here rather than silently rewriting AC text.
 */
export function flipAcCheckbox(
  body: string,
  taskId: string,
  index: number
): FlipAcCheckboxResult {
  const items = findAcItems(body)
  if (index < 0 || index >= items.length) {
    throw new AcIndexOutOfRangeError(taskId, index, items.length)
  }
  const item = items[index]
  if (item.checked) throw new AcAlreadyCheckedError(taskId, index)

  const before = body.slice(0, item.bracketStart)
  const after = body.slice(item.bracketStart + 3) // skip "[ ]"
  const newBody = `${before}[x]${after}`

  assertNarrowDiff(body, newBody, item.bracketStart, taskId)
  return { newBody, item }
}

/**
 * Exported for safety-net unit tests. Production code reaches it only via
 * `flipAcCheckbox`, which constructs `newBody` itself.
 */
export function assertNarrowDiff(
  oldBody: string,
  newBody: string,
  bracketStart: number,
  taskId: string
): void {
  if (oldBody.length !== newBody.length) {
    throw new BodyLockViolationError(
      taskId,
      `length changed (${oldBody.length} → ${newBody.length})`
    )
  }
  for (let i = 0; i < oldBody.length; i++) {
    if (oldBody[i] === newBody[i]) continue
    // The only legal change is the inner char of "[ ]" → "[x]" at bracketStart+1.
    const expectedPos = bracketStart + 1
    if (i !== expectedPos) {
      throw new BodyLockViolationError(taskId, `unexpected change at offset ${i}`)
    }
    if (oldBody[i] !== ' ' || newBody[i].toLowerCase() !== 'x') {
      throw new BodyLockViolationError(
        taskId,
        `expected ' ' → 'x' at offset ${i}, got '${oldBody[i]}' → '${newBody[i]}'`
      )
    }
  }
}

function computeLineOffsets(body: string, lineCount: number): number[] {
  const offsets: number[] = new Array(lineCount)
  offsets[0] = 0
  let line = 0
  for (let i = 0; i < body.length && line < lineCount - 1; i++) {
    const c = body[i]
    if (c === '\n') {
      line++
      offsets[line] = i + 1
    } else if (c === '\r') {
      // Treat \r\n and lone \r the same way splitLines does (/\r?\n/ — lone \r stays on the line).
      if (body[i + 1] === '\n') {
        line++
        offsets[line] = i + 2
        i++
      }
    }
  }
  // Fill any remaining (shouldn't happen with correct lineCount, but safe).
  for (let i = line + 1; i < lineCount; i++) offsets[i] = body.length
  return offsets
}
