// TASK-1791 — the diff parser, checked against git rather than against itself.
//
// AC-1 is the load-bearing test: the add/del counts the parser derives must
// equal the counts `git --numstat` reports for the same commit. A parser
// verified only against fixtures it also authored can be confidently wrong in
// exactly the way that matters — a dropped or invented line shifts every number
// after it, and every number is the answer this task exists to give.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseUnifiedDiff,
  firstChangedLine,
  MAX_FILE_PATCH_BYTES,
  type Hunk
} from './commit-diff'

let repo: string
let editSha = ''
let binarySha = ''
let renameSha = ''
let hugeSha = ''

function run(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
const patchOf = (sha: string): string => run(['show', '--format=', '--unified=3', '-M', sha, '--'])

/** git's own answer for a commit: path -> [insertions, deletions]. */
function numstatOf(sha: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>()
  for (const line of run(['show', '--numstat', '--format=', sha, '--']).split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [ins, del, ...rest] = line.split('\t')
    out.set(rest.join('\t'), [Number.parseInt(ins, 10), Number.parseInt(del, 10)])
  }
  return out
}

function countKinds(hunks: Hunk[]): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') add += 1
      if (l.kind === 'del') del += 1
    }
  }
  return { add, del }
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-diff-'))
  run(['init', '-q', '-b', 'main'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  run(['config', 'commit.gpgsign', 'false'])

  // A file long enough that a mid-file edit produces real, non-trivial numbers.
  const original = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(repo, 'a.txt'), original)
  fs.writeFileSync(path.join(repo, 'keep.txt'), 'unchanged\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'seed'])

  // Edit in the middle: replace line 20, insert two after line 30.
  const edited = original
    .split('\n')
    .map((l, i) => (i === 19 ? 'line 20 CHANGED' : l))
    .flatMap((l, i) => (i === 29 ? [l, 'inserted A', 'inserted B'] : [l]))
    .join('\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), edited)
  run(['add', 'a.txt'])
  run(['commit', '-q', '-m', 'edit the middle'])
  editSha = run(['rev-parse', 'HEAD']).trim()

  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7, 9]))
  run(['add', 'blob.bin'])
  run(['commit', '-q', '-m', 'add a binary'])
  binarySha = run(['rev-parse', 'HEAD']).trim()

  run(['mv', 'keep.txt', 'moved.txt'])
  run(['commit', '-q', '-m', 'rename it'])
  renameSha = run(['rev-parse', 'HEAD']).trim()

  // Comfortably past the cap, so the omission path is exercised for real.
  const huge = Array.from({ length: 20000 }, (_, i) => `generated line ${i}`).join('\n') + '\n'
  fs.writeFileSync(path.join(repo, 'generated.txt'), huge)
  run(['add', 'generated.txt'])
  run(['commit', '-q', '-m', 'add a generated file'])
  hugeSha = run(['rev-parse', 'HEAD']).trim()
})

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true })
})

describe('the parser agrees with git (AC-1)', () => {
  it('derives the same add/del counts numstat reports', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    expect(file?.hunks).not.toBeNull()
    const counts = countKinds(file!.hunks!)
    const [ins, del] = numstatOf(editSha).get('a.txt')!
    // If the parse dropped or invented a line, these disagree — and every line
    // number after the mistake would be wrong with no other symptom.
    expect(counts.add).toBe(ins)
    expect(counts.del).toBe(del)
  })
})

describe('line numbers are the file\'s own (AC-3)', () => {
  it('numbers a changed line where it actually sits, not where the hunk starts', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    const lines = file!.hunks!.flatMap((h) => h.lines)

    const changed = lines.find((l) => l.kind === 'add' && l.text === 'line 20 CHANGED')
    expect(changed?.newNo).toBe(20)
    const removed = lines.find((l) => l.kind === 'del' && l.text === 'line 20')
    expect(removed?.oldNo).toBe(20)
  })

  it('keeps counting across an insertion, so later lines shift', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    const lines = file!.hunks!.flatMap((h) => h.lines)
    const a = lines.find((l) => l.text === 'inserted A')
    const b = lines.find((l) => l.text === 'inserted B')
    expect(a?.newNo).toBe(31)
    expect(b?.newNo).toBe(32)
    // Added lines exist only in the new file.
    expect(a?.oldNo).toBeNull()
  })

  it('gives a context line both numbers, and they differ after an insertion', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    const ctx = file!.hunks!.flatMap((h) => h.lines).filter((l) => l.kind === 'ctx')
    expect(ctx.every((l) => l.oldNo !== null && l.newNo !== null)).toBe(true)
    const after = ctx.filter((l) => l.newNo! > 32)
    // Two lines were inserted above, so the new numbering runs two ahead.
    expect(after.every((l) => l.newNo! - l.oldNo! === 2)).toBe(true)
  })

  it('numbers match git blame-able reality for the first hunk header', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    const h = file!.hunks![0]!
    const raw = patchOf(editSha).split(/\r?\n/).find((l) => l.startsWith('@@'))!
    expect(raw).toContain(`-${h.oldStart},${h.oldLines}`)
    expect(raw).toContain(`+${h.newStart},${h.newLines}`)
  })
})

describe('files that have no patch to give (AC-4)', () => {
  it('reports a binary file as null hunks, not an empty array', () => {
    const [file] = parseUnifiedDiff(patchOf(binarySha))
    expect(file?.path).toBe('blob.bin')
    // [] would say the file changed nothing.
    expect(file?.hunks).toBeNull()
    expect(file?.omitted).toBe('binary')
  })

  it('CONTROL — a text file in the same repo DOES get hunks', () => {
    // Without this, a parser that returned null for everything would pass.
    const [file] = parseUnifiedDiff(patchOf(editSha))
    expect(file?.hunks).not.toBeNull()
    expect(file!.hunks!.length).toBeGreaterThan(0)
  })

  it('reports an oversized file as too-large, distinctly from binary (AC-5)', () => {
    const [file] = parseUnifiedDiff(patchOf(hugeSha))
    expect(file?.hunks).toBeNull()
    // Two different facts. Collapsing them would tell a reader the file is
    // binary when it is simply enormous.
    expect(file?.omitted).toBe('too-large')
    expect(MAX_FILE_PATCH_BYTES).toBe(256 * 1024)
  })
})

describe('a rename (AC-6)', () => {
  it('reports the file under its NEW path and remembers the old one', () => {
    const files = parseUnifiedDiff(patchOf(renameSha))
    const moved = files.find((f) => f.path === 'moved.txt')
    expect(moved).toBeDefined()
    expect(moved?.oldPath).toBe('keep.txt')
    // A rename must not surface as a whole-file delete plus a whole-file add.
    expect(files.some((f) => f.path === 'keep.txt')).toBe(false)
  })
})

describe('firstChangedLine', () => {
  it('points at the first ADDED line, which is where a reader wants to land', () => {
    const [file] = parseUnifiedDiff(patchOf(editSha))
    expect(firstChangedLine(file!.hunks)).toBe(20)
  })

  it('is null when there is no patch at all', () => {
    expect(firstChangedLine(null)).toBeNull()
  })

  it('falls back to the hunk start for a pure deletion', () => {
    // Nothing was added, so there is no new-file line to land on. The hunk
    // start is where the removal happened; returning nothing would leave the
    // caller with no destination.
    const patch = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -5,3 +5,1 @@',
      ' keep',
      '-gone one',
      '-gone two'
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(firstChangedLine(file!.hunks)).toBe(5)
  })
})

describe('malformed input is survived, not thrown on', () => {
  it('ignores a header it does not model and still yields the hunks', () => {
    const patch = [
      'diff --git a/x.txt b/x.txt',
      'old mode 100644',
      'new mode 100755',
      'index abc..def 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,1 +1,2 @@',
      ' one',
      '+two'
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    // Losing a whole commit's diff to one unfamiliar header would be worse
    // than ignoring the header.
    expect(file?.hunks?.[0]?.lines).toHaveLength(2)
  })

  it('does not count the no-newline marker as a line', () => {
    const patch = [
      'diff --git a/x.txt b/x.txt',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new'
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    const lines = file!.hunks![0]!.lines
    // Counting it would shift every number after it by one.
    expect(lines.map((l) => l.kind)).toEqual(['del', 'add'])
    expect(lines[1]?.newNo).toBe(1)
  })

  it('returns nothing for input that is not a patch', () => {
    expect(parseUnifiedDiff('')).toEqual([])
    expect(parseUnifiedDiff('not a diff at all')).toEqual([])
  })
})
