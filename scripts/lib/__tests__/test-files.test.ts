import { describe, it, expect } from 'vitest'
import { INCLUDE, toRelPosix, parseFilters, matchesFilters, findMissing } from '../test-files.mjs'

describe('INCLUDE', () => {
  it('covers every suite the repo runs', () => {
    expect(INCLUDE).toContain('src/**/*.test.ts')
    expect(INCLUDE).toContain('scripts/**/*.test.ts')
    expect(INCLUDE).toContain('extension/**/*.test.js')
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
