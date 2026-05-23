import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import * as cleanupTools from '../cleanup-tools'
import type { InstrumentedServer } from '../../instrumented-server'

interface CapturedTool {
  name: string
  cb: (args: Record<string, unknown>) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn(
      (name: string, _config: unknown, cb: (args: Record<string, unknown>) => Promise<unknown>) => {
        tools.push({ name, cb })
        return { name } as never
      }
    ) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

interface CleanupResult {
  dryRun: boolean
  knowledgeAction: 'delete' | 'leave'
  archivedWorkspaces: Array<{ id: string; cwd: string }>
  deletedKnowledge: Array<{ slug: string }>
  leftKnowledge: Array<{ slug: string }>
  candidates: {
    workspaces: Array<{ id: string; cwd: string }>
    knowledge: Array<{ slug: string }>
  }
}

function parseResult(result: unknown): CleanupResult {
  const r = result as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text) as CleanupResult
}

function frontmatterDoc(title: string, projectId: string): string {
  return [
    '---',
    'type: decision',
    `title: ${title}`,
    `projectId: ${projectId}`,
    'scope: project',
    'refs: []',
    'createdAt: 2026-05-10T00:00:00.000Z',
    'lastVerifiedAt: 2026-05-10T00:00:00.000Z',
    '---',
    'body'
  ].join('\n')
}

describe('cleanup-tools.cleanup_worktree_orphans', () => {
  let tmpDir: string
  let dbPath: string
  let svc: SqliteTaskService
  let projectCwd: string
  let validWorkspaceCwd: string
  let orphanWorkspaceCwd: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-tools-'))
    dbPath = path.join(tmpDir, 'test.db')
    projectCwd = path.join(tmpDir, 'main-checkout')
    fs.mkdirSync(projectCwd, { recursive: true })

    validWorkspaceCwd = path.join(tmpDir, 'main-checkout.worktrees', 'feature-live')
    fs.mkdirSync(validWorkspaceCwd, { recursive: true })

    // Orphan path: matches `.worktrees` heuristic, never created on disk
    orphanWorkspaceCwd = path.join(tmpDir, 'main-checkout.worktrees', 'task-gone')

    svc = new SqliteTaskService(dbPath)
    await svc.ensureProject('proj-c', 'Cleanup Test', projectCwd)
    await svc.addWorkspace('proj-c', 'live', 'Live', validWorkspaceCwd)
    await svc.addWorkspace('proj-c', 'gone', 'Gone', orphanWorkspaceCwd)

    // Seed valid project-level knowledge (durable path).
    const validKnowledgeFile = path.join(projectCwd, 'docs', 'knowledge', 'valid-entry.md')
    fs.mkdirSync(path.dirname(validKnowledgeFile), { recursive: true })
    fs.writeFileSync(validKnowledgeFile, frontmatterDoc('Valid', 'proj-c'))
    await svc.registerExistingKnowledge({
      filePath: validKnowledgeFile,
      projectId: 'proj-c'
    })

    // Seed orphan: briefly create the workspace folder + file so
    // registerExistingKnowledge accepts it, then rm the whole workspace —
    // mirroring what a deleted worktree leaves behind.
    fs.mkdirSync(orphanWorkspaceCwd, { recursive: true })
    const orphanKnowledgeFile = path.join(orphanWorkspaceCwd, 'docs', 'knowledge', 'orphan-entry.md')
    fs.mkdirSync(path.dirname(orphanKnowledgeFile), { recursive: true })
    fs.writeFileSync(orphanKnowledgeFile, frontmatterDoc('Orphan', 'proj-c'))
    await svc.registerExistingKnowledge({
      filePath: orphanKnowledgeFile,
      projectId: 'proj-c'
    })
    fs.rmSync(orphanWorkspaceCwd, { recursive: true, force: true })
  })

  afterEach(async () => {
    await svc.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('registers exactly one tool named cleanup_worktree_orphans', () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('cleanup_worktree_orphans')
  })

  it('returns Project not found for unknown projectId', async () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)
    const result = (await tools[0].cb({ projectId: 'no-such' })) as {
      content: Array<{ text: string }>
    }
    expect(result.content[0].text).toContain('not found')
  })

  it('dry-run lists candidates without mutating', async () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)

    const result = parseResult(await tools[0].cb({ projectId: 'proj-c' }))

    expect(result.dryRun).toBe(true)
    expect(result.candidates.workspaces.map((w) => w.id)).toEqual(['gone'])
    expect(result.candidates.knowledge.map((k) => k.slug)).toEqual(['orphan-entry'])
    expect(result.archivedWorkspaces).toEqual([])
    expect(result.deletedKnowledge).toEqual([])
    expect(result.leftKnowledge).toEqual([])

    // No mutation
    const live = await svc.findWorkspaces('proj-c', false)
    expect(live.map((w) => w.id).sort()).toEqual(['gone', 'live'])
    expect((await svc.listKnowledge({ projectId: 'proj-c' })).some((k) => k.slug === 'orphan-entry')).toBe(true)
  })

  it('apply with knowledgeAction=leave archives workspaces and reports knowledge', async () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)

    const result = parseResult(
      await tools[0].cb({ projectId: 'proj-c', dryRun: false, knowledgeAction: 'leave' })
    )

    expect(result.dryRun).toBe(false)
    expect(result.archivedWorkspaces.map((w) => w.id)).toEqual(['gone'])
    expect(result.deletedKnowledge).toEqual([])
    expect(result.leftKnowledge.map((k) => k.slug)).toEqual(['orphan-entry'])

    // Workspace archived (no longer in active list)
    const active = (await svc.findWorkspaces('proj-c', false)).map((w) => w.id)
    expect(active).toEqual(['live'])

    // Knowledge row preserved
    expect((await svc.listKnowledge({ projectId: 'proj-c' })).some((k) => k.slug === 'orphan-entry')).toBe(true)
  })

  it('apply with knowledgeAction=delete removes orphan knowledge from index', async () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)

    const result = parseResult(
      await tools[0].cb({ projectId: 'proj-c', dryRun: false, knowledgeAction: 'delete' })
    )

    expect(result.archivedWorkspaces.map((w) => w.id)).toEqual(['gone'])
    expect(result.deletedKnowledge.map((k) => k.slug)).toEqual(['orphan-entry'])
    expect(result.leftKnowledge).toEqual([])

    const slugs = (await svc.listKnowledge({ projectId: 'proj-c' })).map((k) => k.slug)
    expect(slugs).not.toContain('orphan-entry')
    expect(slugs).toContain('valid-entry')
    // Orphan workspace folder NOT resurrected by INDEX.md regen
    expect(fs.existsSync(orphanWorkspaceCwd)).toBe(false)
  })

  it('is idempotent — second run on clean state finds no orphans', async () => {
    const { server, tools } = makeFakeServer()
    cleanupTools.register(server, svc)

    await tools[0].cb({ projectId: 'proj-c', dryRun: false, knowledgeAction: 'delete' })
    const second = parseResult(
      await tools[0].cb({ projectId: 'proj-c', dryRun: false, knowledgeAction: 'delete' })
    )

    expect(second.candidates.workspaces).toEqual([])
    expect(second.candidates.knowledge).toEqual([])
    expect(second.archivedWorkspaces).toEqual([])
    expect(second.deletedKnowledge).toEqual([])
  })
})
