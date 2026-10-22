// TASK-2600 — the suite total and the test cases a commit added, ported from the
// companion web (`packages/web/src/lib/run-tests.ts`, TASK-2562) because the CLI
// cannot import the web package. Keep the two in step: the Runs screen and the
// run report must count the same tests.
//
//   parseSuiteLine   the suite total, from the one fixed shape the loops write
//                    as `testResults.passed[0]` (TASK-2561). Free text is null.
//   addedTestCases   the tests a commit added, read from the ADDED lines of its
//                    diff. A context `[Fact]` already existed and a removed
//                    `test(` is gone, so neither counts.
//   parsePatch       `git show` output → the per-file hunks addedTestCases reads.

export interface SuiteTotal {
  passed: number
  skipped: number
  failed: number
}

export interface AddedTestCase {
  path: string
  name: string
}

export interface PatchLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

export interface PatchFile {
  path: string
  hunks?: { lines: PatchLine[] }[] | null
}

const SUITE_LINE = /^full suite: (\d+) passed, (\d+) skipped, (\d+) failed$/

export function parseSuiteLine(line: string): SuiteTotal | null {
  const m = SUITE_LINE.exec(line)
  if (!m) return null
  return { passed: Number(m[1]), skipped: Number(m[2]), failed: Number(m[3]) }
}

/** `[Fact]`, `[Theory]`, `[Fact(Skip = "x")]` — the attribute that marks an xUnit test. */
const XUNIT_TEST = /^\[(?:Fact|Theory)(?:\(.*\))?\]$/
/** Any other attribute line between the marker and the method (`[InlineData(1)]`). */
const ATTRIBUTE = /^\[.*\]$/
/** The method name: the identifier right before the parameter list. */
const METHOD = /([A-Za-z_]\w*)\s*\(/
/**
 * `it("…"` / `test('…'` / `` it(`…` `` — not preceded by `.` or a word
 * character, so `regex.test("x")` and `it.only(` are not read as tests.
 */
const TS_TEST = /(?<![.\w])(?:it|test)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/

export function addedTestCases(files: PatchFile[]): AddedTestCase[] {
  const out: AddedTestCase[] = []
  for (const file of files) {
    for (const hunk of file.hunks ?? []) {
      // Set by an added xUnit marker; the next added method line names the test.
      let pending = false
      for (const line of hunk.lines) {
        if (line.kind !== 'add') {
          pending = false
          continue
        }
        const text = line.text.trim()
        if (XUNIT_TEST.test(text)) {
          pending = true
          continue
        }
        if (pending) {
          if (text === '' || ATTRIBUTE.test(text)) continue
          const name = METHOD.exec(text)?.[1]
          if (name) out.push({ path: file.path, name: name.replace(/_/g, ' ') })
          pending = false
          continue
        }
        const name = TS_TEST.exec(text)?.[2]
        if (name !== undefined) out.push({ path: file.path, name })
      }
    }
  }
  return out
}

/** A unified diff (`git show --format=`) split into files and hunks. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = []
  let file: PatchFile | null = null
  let lines: PatchLine[] | null = null
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(raw)
      file = { path: m?.[1] ?? '', hunks: [] }
      files.push(file)
      lines = null
      continue
    }
    if (!file) continue
    if (raw.startsWith('+++ ')) {
      if (raw.startsWith('+++ b/')) file.path = raw.slice(6)
      continue
    }
    if (raw.startsWith('--- ') && lines === null) continue
    if (raw.startsWith('@@')) {
      lines = []
      file.hunks?.push({ lines })
      continue
    }
    if (lines === null) continue
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ kind: 'del', text: raw.slice(1) })
    else if (raw.startsWith(' ')) lines.push({ kind: 'ctx', text: raw.slice(1) })
  }
  return files
}
