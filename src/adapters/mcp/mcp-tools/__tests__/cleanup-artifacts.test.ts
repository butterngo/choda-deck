import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { register } from '../cleanup-artifacts'
import type { InstrumentedServer } from '../../instrumented-server'

interface RegisteredTool {
  name: string
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>
}

function makeServerStub(): { tools: RegisteredTool[]; server: InstrumentedServer } {
  const tools: RegisteredTool[] = []
  const server = {
    registerTool: (
      name: string,
      _meta: unknown,
      handler: RegisteredTool['handler']
    ) => {
      tools.push({ name, handler })
    },
    get registeredToolNames(): ReadonlyArray<string> {
      return tools.map((t) => t.name)
    }
  } as unknown as InstrumentedServer
  return { tools, server }
}

interface ArtifactCleanupResult {
  dryRun: boolean
  keepLastN: number
  totalDirs: number
  kept: Array<{ path: string; reason: string }>
  deleted: Array<{ path: string; sizeBytes: number; mtime: string }>
  candidates?: Array<{ path: string; sizeBytes: number; mtime: string }>
}

function parseResult(raw: unknown): ArtifactCleanupResult {
  const r = raw as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text) as ArtifactCleanupResult
}

function makeQueueDir(
  artifactsDir: string,
  name: string,
  opts: { failed?: boolean; noJsonl?: boolean; fileContent?: string } = {}
): string {
  const dir = path.join(artifactsDir, name)
  fs.mkdirSync(dir, { recursive: true })
  if (!opts.noJsonl) {
    const lines: string[] = []
    lines.push(JSON.stringify({ event: 'run.start', ts: Date.now() }))
    if (opts.failed) lines.push(JSON.stringify({ event: 'run.failed', ts: Date.now() }))
    else lines.push(JSON.stringify({ event: 'run.done', ts: Date.now() }))
    fs.writeFileSync(path.join(dir, 'queue.jsonl'), lines.join('\n'))
  }
  if (opts.fileContent) {
    fs.writeFileSync(path.join(dir, 'output.txt'), opts.fileContent)
  }
  return dir
}

describe('cleanup-artifacts', () => {
  let tmpDir: string
  let artifactsDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-artifacts-'))
    artifactsDir = path.join(tmpDir, 'artifacts')
    fs.mkdirSync(artifactsDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers exactly one tool named cleanup_artifacts', () => {
    const { tools, server } = makeServerStub()
    register(server, artifactsDir)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('cleanup_artifacts')
  })

  it('keepLastN cutoff — dirs beyond N are candidates in dry-run', async () => {
    const { tools, server } = makeServerStub()
    register(server, artifactsDir)

    // Create 5 queue dirs; newest-first after sort, so we expect the last 2 to be cut
    for (let i = 1; i <= 5; i++) {
      makeQueueDir(artifactsDir, `queue-run-${String(i).padStart(3, '0')}`)
      // stagger ctimes by touching the dir after a tick — use utimes to force ordering
      const msAgo = (5 - i) * 1000
      const t = new Date(Date.now() - msAgo)
      fs.utimesSync(path.join(artifactsDir, `queue-run-${String(i).padStart(3, '0')}`), t, t)
    }

    const result = parseResult(await tools[0].handler({ keepLastN: 3, dryRun: true }))

    expect(result.dryRun).toBe(true)
    expect(result.totalDirs).toBe(5)
    expect(result.kept).toHaveLength(3)
    expect(result.candidates).toHaveLength(2)
    expect(result.deleted).toHaveLength(0)
    // verify no dirs were actually removed
    expect(fs.readdirSync(artifactsDir)).toHaveLength(5)
  })

  it('failed-run dirs are kept even when beyond keepLastN', async () => {
    const { tools, server } = makeServerStub()
    register(server, artifactsDir)

    // Oldest dir (cut by keepLastN=1) has run.failed — must be kept
    const oldDir = path.join(artifactsDir, 'queue-run-old')
    makeQueueDir(artifactsDir, 'queue-run-old', { failed: true })
    const oldTime = new Date(Date.now() - 10000)
    fs.utimesSync(oldDir, oldTime, oldTime)

    makeQueueDir(artifactsDir, 'queue-run-new')
    const newTime = new Date(Date.now())
    fs.utimesSync(path.join(artifactsDir, 'queue-run-new'), newTime, newTime)

    const result = parseResult(await tools[0].handler({ keepLastN: 1, dryRun: false }))

    expect(result.dryRun).toBe(false)
    expect(result.totalDirs).toBe(2)
    expect(result.kept.map((k) => k.reason)).toContain('failed-run')
    expect(result.deleted).toHaveLength(0)
    // both dirs still exist
    expect(fs.existsSync(oldDir)).toBe(true)
  })

  it('dryRun=true (default) does not mutate the filesystem', async () => {
    const { tools, server } = makeServerStub()
    register(server, artifactsDir)

    for (let i = 1; i <= 3; i++) {
      makeQueueDir(artifactsDir, `queue-run-${i}`)
    }

    // default dryRun=true, keepLastN=1 → 2 candidates but nothing deleted
    const result = parseResult(await tools[0].handler({ keepLastN: 1 }))

    expect(result.dryRun).toBe(true)
    expect(result.deleted).toHaveLength(0)
    expect(fs.readdirSync(artifactsDir)).toHaveLength(3)
  })

  it('pre-TASK-741 dirs (no queue.jsonl) are kept even when beyond keepLastN', async () => {
    const { tools, server } = makeServerStub()
    register(server, artifactsDir)

    // Old dir, no queue.jsonl — should be kept regardless
    const legacyDir = path.join(artifactsDir, 'queue-run-legacy')
    makeQueueDir(artifactsDir, 'queue-run-legacy', { noJsonl: true })
    const oldTime = new Date(Date.now() - 20000)
    fs.utimesSync(legacyDir, oldTime, oldTime)

    // New dir with successful run — will be in top-N
    makeQueueDir(artifactsDir, 'queue-run-new')

    const result = parseResult(await tools[0].handler({ keepLastN: 1, dryRun: false }))

    expect(result.kept.find((k) => k.path === legacyDir)?.reason).toBe('pre-TASK-741')
    expect(result.deleted).toHaveLength(0)
    expect(fs.existsSync(legacyDir)).toBe(true)
  })
})
