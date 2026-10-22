import { describe, it, expect } from 'vitest'
import {
  addedTestCases,
  parsePatch,
  parseSuiteLine,
  type PatchFile,
  type PatchLine
} from '../added-test-cases'

// TASK-2600 — the cases of the companion's run-tests.test.ts (TASK-2562),
// run against the core port, plus the patch reader the CLI feeds it.

const PATH = 'tests/A.Tests/PlatformTests.cs'

const line = (kind: PatchLine['kind'], text: string): PatchLine => ({ kind, text })
const add = (text: string): PatchLine => line('add', text)
const file = (lines: PatchLine[], path = PATH): PatchFile => ({ path, hunks: [{ lines }] })

describe('parseSuiteLine', () => {
  it('reads the fixed shape', () => {
    expect(parseSuiteLine('full suite: 760 passed, 1 skipped, 0 failed')).toEqual({
      passed: 760,
      skipped: 1,
      failed: 0
    })
  })

  it('free text is null', () => {
    expect(parseSuiteLine('dotnet test 329/329')).toBeNull()
  })

  it('anything after the last number is null', () => {
    expect(parseSuiteLine('full suite: 760 passed, 1 skipped, 0 failed (12m)')).toBeNull()
  })
})

describe('addedTestCases', () => {
  it('an added [Fact] names the next added method, underscores as spaces', () => {
    const files = [file([add('[Fact]'), add('    public async Task A_platform_token_is_accepted()')])]
    expect(addedTestCases(files)).toEqual([{ path: PATH, name: 'A platform token is accepted' }])
  })

  it('[Theory] skips further attribute lines to reach the method', () => {
    const files = [file([add('[Theory]'), add('[InlineData(1)]'), add('public void Rounds_down(int x)')])]
    expect(addedTestCases(files).map((t) => t.name)).toEqual(['Rounds down'])
  })

  it('it( and test( with any quote, in line order', () => {
    const files = [file([add('it("does x", () => {})'), add("test('does y', async () => {})")], 'src/a.test.ts')]
    expect(addedTestCases(files).map((t) => t.name)).toEqual(['does x', 'does y'])
  })

  it('a context [Fact] is an existing test, not an added one', () => {
    expect(addedTestCases([file([line('ctx', '[Fact]'), add('public void A_b()')])])).toEqual([])
  })

  it('a removed test( is not counted', () => {
    expect(addedTestCases([file([line('del', "test('gone', () => {})")], 'src/a.test.ts')])).toEqual([])
  })

  it('hunks null or absent contribute nothing and do not throw', () => {
    expect(addedTestCases([{ path: 'a.bin', hunks: null }, { path: 'b.ts' }])).toEqual([])
  })

  it('does not read regex.test( or it.only( as a test', () => {
    const files = [file([add('if (re.test("x")) {}'), add('it.only("focused", () => {})')], 'src/a.ts')]
    expect(addedTestCases(files)).toEqual([])
  })

  it('[Fact(Skip = ...)] still marks a test', () => {
    const files = [file([add('[Fact(Skip = "flaky")]'), add('public void Skipped_one()')])]
    expect(addedTestCases(files).map((t) => t.name)).toEqual(['Skipped one'])
  })

  it('keeps file order across files', () => {
    const files = [file([add("it('first', () => {})")], 'src/b.test.ts'), file([add('[Fact]'), add('public void Second()')])]
    expect(addedTestCases(files)).toEqual([
      { path: 'src/b.test.ts', name: 'first' },
      { path: PATH, name: 'Second' }
    ])
  })
})

describe('parsePatch', () => {
  const PATCH = [
    'diff --git a/src/a.test.ts b/src/a.test.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.test.ts',
    '+++ b/src/a.test.ts',
    '@@ -1,2 +1,3 @@',
    " it('old', () => {})",
    "-it('gone', () => {})",
    "+it('new one', () => {})",
    'diff --git a/tests/X.cs b/tests/X.cs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/tests/X.cs',
    '@@ -0,0 +1,2 @@',
    '+[Fact]',
    '+public void Added_here()'
  ].join('\n')

  it('splits files and keeps add / del / ctx lines', () => {
    const files = parsePatch(PATCH)
    expect(files.map((f) => f.path)).toEqual(['src/a.test.ts', 'tests/X.cs'])
    expect(files[0].hunks?.[0].lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'add'])
  })

  it('feeds addedTestCases', () => {
    expect(addedTestCases(parsePatch(PATCH)).map((t) => t.name)).toEqual(['new one', 'Added here'])
  })
})
