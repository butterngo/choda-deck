import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  findDatabase,
  inspectDataDirs,
  isSilentlyEmpty,
  describeReport,
  defaultCandidates
} from '../data-dir-probe'

let root: string

function makeDir(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a db of `size` bytes under the current layout. */
function withDatabase(dir: string, size = 1024): string {
  const dbPath = path.join(dir, 'database', 'choda-deck.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  fs.writeFileSync(dbPath, Buffer.alloc(size, 1))
  return dbPath
}

/** Write a db at the dir ROOT — the layout that predates the data-dir migration. */
function withLegacyDatabase(dir: string, size = 1024): string {
  const dbPath = path.join(dir, 'choda-deck.db')
  fs.writeFileSync(dbPath, Buffer.alloc(size, 1))
  return dbPath
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dir-probe-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('findDatabase', () => {
  it('finds a database under the current layout', () => {
    const dir = makeDir('current')
    const dbPath = withDatabase(dir)
    const found = findDatabase(dir)
    expect(found?.dbPath).toBe(dbPath)
    expect(found?.legacyLayout).toBe(false)
  })

  it('finds a database at the dir root and flags it as the pre-migration layout', () => {
    // The orphan observed on a real machine 2026-08-05 had exactly this shape: abandoned
    // before scripts/migrate-data-layout.mjs ran, so its .db never moved under database/.
    const dir = makeDir('legacy')
    const dbPath = withLegacyDatabase(dir)
    const found = findDatabase(dir)
    expect(found?.dbPath).toBe(dbPath)
    expect(found?.legacyLayout).toBe(true)
  })

  it('prefers the current layout when a dir somehow holds both', () => {
    const dir = makeDir('both')
    const current = withDatabase(dir)
    withLegacyDatabase(dir)
    expect(findDatabase(dir)?.dbPath).toBe(current)
  })

  it('returns null for an empty dir, a missing dir, and a zero-byte db', () => {
    expect(findDatabase(makeDir('empty'))).toBeNull()
    expect(findDatabase(path.join(root, 'does-not-exist'))).toBeNull()
    const zero = makeDir('zero')
    withDatabase(zero, 0)
    // A zero-byte file is what a half-created profile leaves behind; treating it as
    // populated would suppress the very warning this exists to raise.
    expect(findDatabase(zero)).toBeNull()
  })
})

describe('inspectDataDirs', () => {
  it('reports nothing to worry about when the chosen dir has the database', () => {
    const chosen = makeDir('chosen')
    withDatabase(chosen)
    const report = inspectDataDirs(chosen, [makeDir('other-empty')])
    expect(report.chosenDatabase).not.toBeNull()
    expect(report.others).toEqual([])
    expect(isSilentlyEmpty(report)).toBe(false)
  })

  it('flags the silently-empty case — chosen is blank, another dir is populated', () => {
    const chosen = makeDir('fresh-appdata')
    const real = makeDir('real-data')
    withDatabase(real, 4096)
    const report = inspectDataDirs(chosen, [real])
    expect(report.chosenDatabase).toBeNull()
    expect(report.others).toHaveLength(1)
    expect(isSilentlyEmpty(report)).toBe(true)
  })

  it('orders others largest first, so the likely-live database leads', () => {
    const chosen = makeDir('fresh')
    const small = makeDir('small')
    const big = makeDir('big')
    withDatabase(small, 1024)
    withDatabase(big, 64 * 1024)
    const report = inspectDataDirs(chosen, [small, big])
    expect(report.others.map((o) => o.sizeBytes)).toEqual([64 * 1024, 1024])
  })

  it('does not report the chosen dir as a rival to itself', () => {
    const chosen = makeDir('chosen')
    withDatabase(chosen)
    const report = inspectDataDirs(chosen, [chosen])
    expect(report.others).toEqual([])
  })

  it('does not report a junction pointing at the chosen dir as a second database', () => {
    // The documented workaround is exactly this: %APPDATA%\…\data is a junction onto the
    // real dir. Without realpath resolution the fix would warn about a copy of itself
    // every launch, and the warning would be trained away.
    const chosen = makeDir('real')
    withDatabase(chosen)
    const link = path.join(root, 'link')
    try {
      fs.symlinkSync(chosen, link, 'junction')
    } catch {
      return // no symlink privilege on this machine; the assertion below cannot be made
    }
    const report = inspectDataDirs(chosen, [link])
    expect(report.others).toEqual([])
  })

  it('survives an unreadable candidate rather than throwing at startup', () => {
    const chosen = makeDir('chosen')
    withDatabase(chosen)
    const report = inspectDataDirs(chosen, [path.join(root, 'nope', 'deeper')])
    expect(report.chosenDatabase).not.toBeNull()
    expect(report.others).toEqual([])
  })
})

describe('describeReport', () => {
  it('is empty when there is nothing to warn about', () => {
    const chosen = makeDir('chosen')
    withDatabase(chosen)
    expect(describeReport(inspectDataDirs(chosen, []))).toBe('')
  })

  it('names the path, size and layout of each rival database', () => {
    const chosen = makeDir('fresh')
    const legacy = makeDir('orphan')
    withLegacyDatabase(legacy, 2 * 1024 * 1024)
    const message = describeReport(inspectDataDirs(chosen, [legacy]))
    expect(message).toContain(path.join(legacy, 'choda-deck.db'))
    expect(message).toContain('2.0 MB')
    expect(message).toContain('pre-migration layout')
    expect(message).toContain('which is live')
  })
})

describe('defaultCandidates', () => {
  it('includes cwd/data and both %APPDATA% profiles, pre- and post-rename', () => {
    const candidates = defaultCandidates('C:\\work\\repo')
    expect(candidates.some((c) => c.endsWith(path.join('repo', 'data')))).toBe(true)
    expect(candidates.some((c) => c.includes('choda-deck-companion'))).toBe(true)
    // The pre-rename profile matters: the Electron data dir is keyed on app name, so the
    // rename orphaned a real database that a fresh install would otherwise never see.
    expect(candidates.some((c) => c.endsWith('choda-deck'))).toBe(true)
  })
})
