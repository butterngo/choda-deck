// TASK-1791 — turning `git show`'s unified patch into line-numbered hunks.
//
// The audit chain could name the files a commit touched and how many lines
// moved, and stopped there. "Which line" was deferred deliberately
// (CONV-1787630938979-1: --stat for v1, diff once the view proves used), and it
// cannot come from the graph: ADR-032 chose line-drift tolerance for `code_ref`
// on purpose, because a pinned line is wrong the moment anything above it moves.
// So the answer has to be computed from git at read time, here.
//
// Parsing lives on the adapter rather than in the client. A unified diff has
// more edge cases than it looks — renames, mode-only changes, binary markers,
// `\ No newline at end of file` — and one parser that is right is easier to
// reach than one per consumer.

/** A file whose patch was not produced reports `null`, never an empty array. */
export type Hunks = Hunk[] | null

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  /** Line number in the OLD file. Null on an added line. */
  oldNo: number | null
  /** Line number in the NEW file. Null on a removed line. */
  newNo: number | null
}

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the second `@@`, which git fills with the enclosing symbol. */
  header: string
  lines: DiffLine[]
}

export interface FileDiff {
  /** Path in the NEW tree. A rename reports where the file ended up. */
  path: string
  /** Set only on a rename, so a reader can see where it came from. */
  oldPath?: string
  hunks: Hunks
  /** Why `hunks` is null, when it is. Absent when hunks were produced. */
  omitted?: 'binary' | 'too-large'
}

/**
 * Per-file cap on patch text.
 *
 * Measured 2026-08-26 in choda-deck-companion: the largest single-commit patch
 * in the last 50 commits was 65 KB. 256 KB leaves roughly 4x headroom for an
 * ordinary commit while still bounding the shape that actually blows up — a
 * vendored dependency or a generated lockfile landing in one commit, where the
 * patch is real, enormous, and of no interest to anyone auditing it.
 *
 * Hitting the cap reports `omitted: 'too-large'`, never an empty diff. An empty
 * diff would say the file did not change.
 */
export const MAX_FILE_PATCH_BYTES = 256 * 1024

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * Parse the output of `git show --format= <sha>` into per-file hunks.
 *
 * Unknown or unhandled header lines are skipped rather than thrown on: a patch
 * carrying a mode change we do not model should still yield its hunks, and an
 * audit view that lost a whole commit to one unfamiliar header would be worse
 * than one that ignored the header.
 */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = []
  const lines = patch.split(/\r?\n/)

  let current: FileDiff | null = null
  let hunk: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  let bytes = 0

  const closeFile = (): void => {
    if (current === null) return
    if (hunk !== null) {
      current.hunks?.push(hunk)
      hunk = null
    }
    files.push(current)
    current = null
  }

  for (const line of lines) {
    const header = DIFF_HEADER.exec(line)
    if (header) {
      closeFile()
      bytes = 0
      current = { path: header[2], hunks: [] }
      continue
    }
    if (current === null) continue

    // A binary file has no hunks to produce — not zero hunks.
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.hunks = null
      current.omitted = 'binary'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length)
      continue
    }
    // Already given up on this file; keep scanning for the next `diff --git`.
    if (current.hunks === null) continue

    const hh = HUNK_HEADER.exec(line)
    if (hh) {
      if (hunk !== null) current.hunks.push(hunk)
      const oldStart = Number.parseInt(hh[1], 10)
      const newStart = Number.parseInt(hh[3], 10)
      hunk = {
        oldStart,
        oldLines: hh[2] === undefined ? 1 : Number.parseInt(hh[2], 10),
        newStart,
        newLines: hh[4] === undefined ? 1 : Number.parseInt(hh[4], 10),
        header: hh[5] ?? '',
        lines: []
      }
      // Numbering continues from the hunk header, which is what makes these
      // real file line numbers rather than offsets within the hunk.
      oldNo = oldStart
      newNo = newStart
      continue
    }
    if (hunk === null) continue

    bytes += line.length + 1
    if (bytes > MAX_FILE_PATCH_BYTES) {
      current.hunks = null
      current.omitted = 'too-large'
      hunk = null
      continue
    }

    // `\ No newline at end of file` annotates the line above and is not itself
    // a line of the file — counting it would shift every number after it.
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo })
      newNo += 1
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null })
      oldNo += 1
    } else if (line.startsWith(' ') || line === '') {
      // An empty string here is a context line that was itself empty: git emits
      // a single space, and a trailing split can drop it.
      hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo })
      oldNo += 1
      newNo += 1
    }
  }
  closeFile()
  return files
}

/** The first line a reader should be taken to, or null when nothing was added. */
export function firstChangedLine(hunks: Hunks): number | null {
  if (hunks === null) return null
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add' && l.newNo !== null) return l.newNo
    }
  }
  // A pure deletion has no line in the new file to land on. Reporting the hunk
  // start is honest — it is where the removal happened — and reporting nothing
  // would leave the caller with no destination at all.
  for (const h of hunks) {
    if (h.lines.some((l) => l.kind === 'del')) return h.newStart
  }
  return null
}
