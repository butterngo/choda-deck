import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { register, type BackupToolsDeps } from '../backup-tools'
import { backupDir } from '../../../../core/backup-service'

interface RegisteredTool {
  name: string
  handler: (args?: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
  }>
}

function makeServerStub(): {
  tools: RegisteredTool[]
  registerTool: (name: string, _meta: unknown, handler: RegisteredTool['handler']) => void
} {
  const tools: RegisteredTool[] = []
  return {
    tools,
    registerTool: (name, _meta, handler) => {
      tools.push({ name, handler })
    }
  }
}

class FakeDb implements BackupToolsDeps {
  backupCalls: string[] = []
  closeCalls = 0
  backup(absolutePath: string): void {
    this.backupCalls.push(absolutePath)
    writeFileSync(absolutePath, 'fake-db')
  }
  close(): void {
    this.closeCalls += 1
  }
}

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'choda-backup-tools-'))
}

describe('backup-tools register', () => {
  let dataDir: string
  let dbPath: string
  let svc: FakeDb
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    dataDir = makeDataDir()
    dbPath = join(dataDir, 'database', 'choda-deck.db')
    mkdirSync(join(dataDir, 'database'), { recursive: true })
    writeFileSync(dbPath, 'live-db-content')
    svc = new FakeDb()
    server = makeServerStub()
    register(server as unknown as Parameters<typeof register>[0], svc, dataDir, dbPath)
  })

  it('registers backup_list, backup_create, and backup_restore', () => {
    expect(server.tools.map((t) => t.name).sort()).toEqual([
      'backup_create',
      'backup_list',
      'backup_restore'
    ])
  })

  it('backup_list handler returns empty list when no backups exist', async () => {
    const tool = server.tools.find((t) => t.name === 'backup_list')!
    const result = await tool.handler()
    expect(JSON.parse(result.content[0].text)).toEqual([])
  })

  it('backup_list handler returns existing backups newest-first', async () => {
    const dir = backupDir(dataDir)
    mkdirSync(dir, { recursive: true })
    const older = join(dir, 'choda-deck-2026-04-18.db')
    const newer = join(dir, 'choda-deck-2026-04-20.db')
    writeFileSync(older, 'x')
    writeFileSync(newer, 'x')
    const pastSec = Date.now() / 1000 - 2 * 24 * 60 * 60
    utimesSync(older, pastSec, pastSec)
    const tool = server.tools.find((t) => t.name === 'backup_list')!
    const result = await tool.handler()
    const parsed = JSON.parse(result.content[0].text) as Array<{ filename: string }>
    expect(parsed.map((b) => b.filename)).toEqual([
      'choda-deck-2026-04-20.db',
      'choda-deck-2026-04-18.db'
    ])
  })

  it('backup_create handler calls svc.backup with dated path and returns info', async () => {
    const tool = server.tools.find((t) => t.name === 'backup_create')!
    const result = await tool.handler()
    const info = JSON.parse(result.content[0].text) as { filename: string; size: number }
    expect(info.filename).toMatch(/^choda-deck-\d{4}-\d{2}-\d{2}\.db$/)
    expect(svc.backupCalls).toHaveLength(1)
    expect(svc.backupCalls[0]).toContain(info.filename)
    expect(existsSync(svc.backupCalls[0])).toBe(true)
  })

  describe('backup_restore', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      vi.useFakeTimers()
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    })

    afterEach(() => {
      vi.useRealTimers()
      exitSpy.mockRestore()
    })

    it('returns error when filename does not exist', async () => {
      const tool = server.tools.find((t) => t.name === 'backup_restore')!
      const result = await tool.handler({ filename: 'choda-deck-9999-99-99.db' })
      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; error: string }
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain('not found')
      expect(svc.closeCalls).toBe(0)
      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('closes svc, copies backup over dbPath, schedules exit, returns success', async () => {
      const dir = backupDir(dataDir)
      mkdirSync(dir, { recursive: true })
      const backupFile = join(dir, 'choda-deck-2026-04-20.db')
      writeFileSync(backupFile, 'backup-content')

      const tool = server.tools.find((t) => t.name === 'backup_restore')!
      const result = await tool.handler({ filename: 'choda-deck-2026-04-20.db' })

      const parsed = JSON.parse(result.content[0].text) as { ok: boolean; restored: string }
      expect(parsed.ok).toBe(true)
      expect(parsed.restored).toBe('choda-deck-2026-04-20.db')
      expect(svc.closeCalls).toBe(1)
      expect(readFileSync(dbPath, 'utf8')).toBe('backup-content')

      // process.exit scheduled via setTimeout — advance timers to verify
      expect(exitSpy).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(exitSpy).toHaveBeenCalledWith(0)
    })
  })
})
