import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { register, type BackupToolsDeps } from '../backup-tools'
import { backupDir } from '../../../../core/backup-service'

interface RegisteredTool {
  name: string
  handler: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>
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
  calls: string[] = []
  backup(absolutePath: string): void {
    this.calls.push(absolutePath)
    writeFileSync(absolutePath, 'fake-db')
  }
}

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'choda-backup-tools-'))
}

describe('backup-tools register', () => {
  let dataDir: string
  let svc: FakeDb
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    dataDir = makeDataDir()
    svc = new FakeDb()
    server = makeServerStub()
    // The McpServer signature is wider than our stub — the cast keeps the
    // test focused on the two methods register() actually calls.
    register(server as unknown as Parameters<typeof register>[0], svc, dataDir)
  })

  it('registers backup_list and backup_create', () => {
    expect(server.tools.map((t) => t.name).sort()).toEqual(['backup_create', 'backup_list'])
  })

  it('does NOT register backup_restore (intentionally deferred)', () => {
    expect(server.tools.find((t) => t.name === 'backup_restore')).toBeUndefined()
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
    expect(svc.calls).toHaveLength(1)
    expect(svc.calls[0]).toContain(info.filename)
    expect(existsSync(svc.calls[0])).toBe(true)
  })
})
