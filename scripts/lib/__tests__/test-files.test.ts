import { describe, it, expect } from 'vitest'
import {
  INCLUDE,
  toRelPosix,
  parseFilters,
  matchesFilters,
  findMissing,
  patternToRegExp,
  findTestFiles
} from '../test-files.mjs'

/** Minimal readdirSync stand-in over a { path: [entries] } shape. */
function fakeReaddir(tree: Record<string, Array<[string, 'dir' | 'file']>>) {
  return (dir: string) =>
    (tree[dir] ?? []).map(([name, kind]) => ({
      name,
      isDirectory: () => kind === 'dir'
    }))
}

describe('INCLUDE', () => {
  it('covers every suite the repo runs', () => {
    expect(INCLUDE).toContain('src/**/*.test.ts')
    expect(INCLUDE).toContain('scripts/**/*.test.ts')
    expect(INCLUDE).toContain('extension/**/*.test.js')
  })
})

describe('patternToRegExp', () => {
  it('matches at any depth under a ** segment, including zero directories', () => {
    const re = patternToRegExp('src/**/*.test.ts')
    expect(re.test('src/a.test.ts')).toBe(true)
    expect(re.test('src/core/domain/a.test.ts')).toBe(true)
  })

  it('does not match the wrong extension or a sibling root', () => {
    const re = patternToRegExp('src/**/*.test.ts')
    expect(re.test('src/core/a.ts')).toBe(false)
    expect(re.test('src/core/a.test.js')).toBe(false)
    expect(re.test('other/a.test.ts')).toBe(false)
  })

  it('treats a dot literally rather than as any-char', () => {
    expect(patternToRegExp('extension/**/*.test.js').test('extension/aXtestYjs')).toBe(false)
  })
})

describe('findTestFiles', () => {
  // fs.globSync would be the obvious tool, but it lands in Node 22 and CI runs
  // Node 20 — importing it there throws before a single test runs.
  const tree = {
    '/repo': [
      ['src', 'dir'],
      ['node_modules', 'dir'],
      ['README.md', 'file']
    ],
    '/repo/src': [
      ['core', 'dir'],
      ['a.test.ts', 'file'],
      ['a.ts', 'file']
    ],
    '/repo/src/core': [['deep.test.ts', 'file']],
    '/repo/node_modules': [['evil.test.ts', 'file']]
  } as Record<string, Array<[string, 'dir' | 'file']>>

  it('finds matching files at every depth', () => {
    expect(findTestFiles('/repo', ['src/**/*.test.ts'], fakeReaddir(tree))).toEqual([
      'src/a.test.ts',
      'src/core/deep.test.ts'
    ])
  })

  it('never descends into node_modules', () => {
    const found = findTestFiles('/repo', ['**/*.test.ts'], fakeReaddir(tree))
    expect(found.some((p) => p.includes('node_modules'))).toBe(false)
  })
})

describe('toRelPosix', () => {
  it('makes an absolute windows path relative with forward slashes', () => {
    expect(toRelPosix('C:\\dev\\choda-deck\\extension\\lib\\selector.test.js', 'C:\\dev\\choda-deck')).toBe(
      'extension/lib/selector.test.js'
    )
  })

  it('tolerates drive-letter case differing between vitest and process.cwd()', () => {
    // vitest reports c:/… while process.cwd() gives C:\… — a naive prefix strip
    // leaves the path absolute, every file reads as "missing", and the guard fires
    // on a perfectly good run.
    expect(toRelPosix('c:/dev/choda-deck/src/a.test.ts', 'C:\\dev\\choda-deck')).toBe('src/a.test.ts')
  })

  it('leaves an already-relative path alone', () => {
    expect(toRelPosix('src/a.test.ts', 'C:\\dev\\choda-deck')).toBe('src/a.test.ts')
  })
})

describe('parseFilters', () => {
  it('drops the run verb', () => {
    expect(parseFilters(['run'])).toEqual([])
  })

  it('keeps positional file filters', () => {
    expect(parseFilters(['run', 'extension'])).toEqual(['extension'])
  })

  it('drops flags so they are never mistaken for file filters', () => {
    expect(parseFilters(['run', '--coverage', '--reporter=json', 'extension'])).toEqual(['extension'])
  })
})

describe('matchesFilters', () => {
  it('matches everything when unfiltered', () => {
    expect(matchesFilters('src/a.test.ts', [])).toBe(true)
  })

  it('matches on a path substring the way vitest does', () => {
    expect(matchesFilters('extension/lib/selector.test.js', ['extension'])).toBe(true)
    expect(matchesFilters('src/core/a.test.ts', ['extension'])).toBe(false)
  })

  it('normalizes a backslash filter typed on windows', () => {
    expect(matchesFilters('extension/lib/selector.test.js', ['extension\\lib'])).toBe(true)
  })
})

describe('findMissing', () => {
  it('returns nothing when every expected file ran', () => {
    expect(findMissing(['src/a.test.ts', 'src/b.test.ts'], ['src/b.test.ts', 'src/a.test.ts'])).toEqual([])
  })

  it('names the files that never ran — the TASK-1514 silent-skip case', () => {
    // Exactly the happy-dom failure: the two DOM-environment files drop out of the
    // run while the remaining ten report a clean pass.
    // (Do not write the environment pragma verbatim in this file — vitest scans the
    // whole source for it and would try to load an environment by that name.)
    const expected = [
      'extension/lib/selector.test.js',
      'extension/lib/snapshot.test.js',
      'extension/lib/recorder.test.js'
    ]
    expect(findMissing(expected, ['extension/lib/recorder.test.js'])).toEqual([
      'extension/lib/selector.test.js',
      'extension/lib/snapshot.test.js'
    ])
  })

  it('compares case-insensitively so a drive/case mismatch is not a false alarm', () => {
    expect(findMissing(['src/A.test.ts'], ['src/a.test.ts'])).toEqual([])
  })
})
