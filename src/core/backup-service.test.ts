import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  backupDir,
  listBackups,
  shouldRunDailyBackup,
  pruneOld,
  runBackup,
  createNamedBackup,
  type Backupable
} from './backup-service'

function makeUserData(): string {
  return mkdtempSync(join(tmpdir(), 'choda-backup-'))
}

function touch(path: string, content = 'x'): void {
  writeFileSync(path, content)
}

class FakeDb implements Backupable {
  calls: string[] = []
  backup(absolutePath: string): void {
    this.calls.push(absolutePath)
    touch(absolutePath, 'fake-db-content')
  }
}

describe('backup-service', () => {
  let userData: string

  beforeEach(() => {
    userData = makeUserData()
  })

  describe('listBackups', () => {
    it('returns empty when folder does not exist', () => {
      expect(listBackups(userData)).toEqual([])
    })

    it('filters non-matching filenames', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      touch(join(dir, 'choda-deck-2026-04-18.db'))
      touch(join(dir, 'not-a-backup.txt'))
      touch(join(dir, 'choda-deck-wrong.db'))
      const list = listBackups(userData)
      expect(list.map((b) => b.filename)).toEqual(['choda-deck-2026-04-18.db'])
    })

    it('sorts newest first by mtime', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      const old = join(dir, 'choda-deck-2026-04-10.db')
      const recent = join(dir, 'choda-deck-2026-04-18.db')
      touch(old)
      touch(recent)
      const pastMs = Date.now() / 1000 - 10 * 24 * 60 * 60
      utimesSync(old, pastMs, pastMs)
      const list = listBackups(userData)
      expect(list[0].filename).toBe('choda-deck-2026-04-18.db')
      expect(list[1].filename).toBe('choda-deck-2026-04-10.db')
    })
  })

  describe('shouldRunDailyBackup', () => {
    it('returns true when no backups exist', () => {
      expect(shouldRunDailyBackup(userData)).toBe(true)
    })

    it('returns false when newest is fresh', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      touch(join(dir, 'choda-deck-2026-04-18.db'))
      expect(shouldRunDailyBackup(userData)).toBe(false)
    })

    it('returns true when newest is older than 24h', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'choda-deck-2026-04-17.db')
      touch(path)
      const pastMs = Date.now() / 1000 - 25 * 60 * 60
      utimesSync(path, pastMs, pastMs)
      expect(shouldRunDailyBackup(userData)).toBe(true)
    })
  })

  describe('runBackup', () => {
    it('creates dir and writes dated file via db.backup', () => {
      const db = new FakeDb()
      const info = runBackup(db, userData, new Date('2026-04-18T10:00:00'))
      expect(info.filename).toBe('choda-deck-2026-04-18.db')
      expect(db.calls).toHaveLength(1)
      expect(db.calls[0]).toContain('choda-deck-2026-04-18.db')
      expect(existsSync(db.calls[0])).toBe(true)
    })

    it('overwrites same-day file', () => {
      const db = new FakeDb()
      runBackup(db, userData, new Date('2026-04-18T09:00:00'))
      runBackup(db, userData, new Date('2026-04-18T10:00:00'))
      const list = listBackups(userData)
      expect(list).toHaveLength(1)
      expect(list[0].filename).toBe('choda-deck-2026-04-18.db')
    })

    it('prunes to 7 newest after backup', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      for (let i = 1; i <= 10; i++) {
        const name = `choda-deck-2026-04-${String(i).padStart(2, '0')}.db`
        touch(join(dir, name))
        const ts = Date.now() / 1000 - (30 - i) * 24 * 60 * 60
        utimesSync(join(dir, name), ts, ts)
      }
      const db = new FakeDb()
      runBackup(db, userData, new Date('2026-04-18T10:00:00'))
      const files = readdirSync(dir).filter((f) => f.startsWith('choda-deck-'))
      expect(files).toHaveLength(7)
      expect(files).toContain('choda-deck-2026-04-18.db')
      expect(files).not.toContain('choda-deck-2026-04-01.db')
    })
  })

  describe('createNamedBackup', () => {
    it('writes a non-rotation backup file with the given name', () => {
      const db = new FakeDb()
      const target = createNamedBackup(db, userData, 'pre-import-2026-05-08T12-00-00Z')
      expect(target.endsWith('pre-import-2026-05-08T12-00-00Z.db')).toBe(true)
      expect(existsSync(target)).toBe(true)
    })

    it('does not appear in listBackups (filename pattern is distinct)', () => {
      const db = new FakeDb()
      createNamedBackup(db, userData, 'pre-import-x')
      expect(listBackups(userData)).toEqual([])
    })

    it('survives pruneOld — pre-import backups are never rotation-pruned', () => {
      const db = new FakeDb()
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      for (let i = 1; i <= 10; i++) {
        const name = `choda-deck-2026-04-${String(i).padStart(2, '0')}.db`
        touch(join(dir, name))
        const ts = Date.now() / 1000 - (30 - i) * 24 * 60 * 60
        utimesSync(join(dir, name), ts, ts)
      }
      const target = createNamedBackup(db, userData, 'pre-import-stable')
      pruneOld(userData, 3)
      expect(existsSync(target)).toBe(true)
    })

    it('overwrites an existing same-named file', () => {
      const db = new FakeDb()
      const a = createNamedBackup(db, userData, 'pre-import-collide')
      const b = createNamedBackup(db, userData, 'pre-import-collide')
      expect(a).toBe(b)
      expect(existsSync(a)).toBe(true)
    })

    it('rejects names with path separators', () => {
      const db = new FakeDb()
      expect(() => createNamedBackup(db, userData, '../escape')).toThrow(/path separators/)
      expect(() => createNamedBackup(db, userData, 'sub/file')).toThrow(/path separators/)
    })

    it('rejects empty name', () => {
      const db = new FakeDb()
      expect(() => createNamedBackup(db, userData, '')).toThrow(/invalid name/)
    })
  })

  describe('pruneOld', () => {
    it('keeps N newest by mtime', () => {
      const dir = backupDir(userData)
      mkdirSync(dir, { recursive: true })
      for (let i = 1; i <= 5; i++) {
        const name = `choda-deck-2026-04-${String(i).padStart(2, '0')}.db`
        touch(join(dir, name))
        const ts = Date.now() / 1000 - (10 - i) * 24 * 60 * 60
        utimesSync(join(dir, name), ts, ts)
      }
      pruneOld(userData, 3)
      const files = readdirSync(dir).sort()
      expect(files).toEqual([
        'choda-deck-2026-04-03.db',
        'choda-deck-2026-04-04.db',
        'choda-deck-2026-04-05.db'
      ])
    })
  })
})
