// Unit test for the GET /tasks/:id task-detail route handler.

import { describe, it, expect } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleTaskDetailRoute } from './task-detail'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Task } from '../../core/domain/task-types'

interface Captured {
  status: number
  body: unknown
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      cap.status = status
      return this
    },
    end(payload?: string) {
      cap.body = payload ? JSON.parse(payload) : undefined
      return this
    }
  } as unknown as ServerResponse
}

const TOKEN = 'bridge-token-for-tests'

// `null` means "send no token" — an explicit `undefined` would re-trigger the
// default and silently send one, which is exactly how the 401 case can pass by
// never being exercised.
function req(url: string, method = 'GET', token: string | null = TOKEN): IncomingMessage {
  return { url, method, headers: token ? { 'x-choda-bridge-token': token } : {} } as unknown as IncomingMessage
}

const task: Task = {
  id: 'TASK-1',
  projectId: 'p1',
  parentTaskId: null,
  title: 'graph view',
  status: 'IMPLEMENTED',
  priority: 'medium',
  labels: ['companion'],
  dueDate: null,
  pinned: false,
  filePath: null,
  body: '## Context\nbody here\n## Acceptance\n- [ ] AC-1',
  blockedBy: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

interface ProvenanceFixture {
  touches?: Array<{ taskId: string; codeRefSlug: string; relation: 'modifies' | 'reference' }>
  codeRefs?: Record<string, { path: string; workspaceId: string | null }>
  workspaces?: Record<string, string>
  sessions?: Array<{
    id: string
    taskId: string | null
    workspaceId: string | null
    handoff: { commits?: string[] } | null
  }>
  decisions?: Array<{
    slug: string
    title: string
    body: string
    realizesTasks?: string[]
    /** Reading this entry throws, as a malformed frontmatter refs block does. */
    unreadable?: boolean
  }>
  /** Captures the filter listKnowledge was called with, to prove project scoping. */
  seenKnowledgeFilter?: { projectId?: string; type?: string }
}

function fakeSvc(fx: ProvenanceFixture = {}): BackendTaskService {
  return {
    getTask: async (id: string) => (id === 'TASK-1' ? task : null),
    getTouchesForTask: async (taskId: string) =>
      (fx.touches ?? []).filter((t) => t.taskId === taskId),
    getCodeRef: async (slug: string) => {
      const ref = (fx.codeRefs ?? {})[slug]
      return ref ? { slug, ...ref } : null
    },
    getWorkspace: async (id: string) =>
      (fx.workspaces ?? {})[id] ? { id, cwd: (fx.workspaces ?? {})[id] } : null,
    findSessions: async () => fx.sessions ?? [],
    listKnowledge: async (filter?: { projectId?: string; type?: string }) => {
      fx.seenKnowledgeFilter = filter
      return (fx.decisions ?? []).map((d) => ({ slug: d.slug, title: d.title }))
    },
    // TASK-1785 — provenance reads through readKnowledgeSource now, because
    // getKnowledge computes staleness with a `git log` per ref and nothing on
    // this path reads it. Both are stubbed: the route must keep working
    // whichever one a future caller reaches for, and stubbing only the one
    // under test is how this fake silently emptied `adrs` when the production
    // call moved (typecheck passed the whole time — the fake is a cast).
    readKnowledgeSource: async (slug: string) => {
      const d = (fx.decisions ?? []).find((x) => x.slug === slug)
      if (d?.unreadable) throw new Error('Frontmatter parse: ref missing path or commitSha')
      return d
        ? { slug, body: d.body, frontmatter: { structured: { realizesTasks: d.realizesTasks } } }
        : null
    },
    getKnowledge: async (slug: string) => {
      const d = (fx.decisions ?? []).find((x) => x.slug === slug)
      if (d?.unreadable) throw new Error('Frontmatter parse: ref missing path or commitSha')
      return d
        ? { slug, body: d.body, frontmatter: { structured: { realizesTasks: d.realizesTasks } } }
        : null
    }
  } as unknown as BackendTaskService
}

describe('handleTaskDetailRoute', () => {
  it('returns false for a non-task path', async () => {
    const cap = {} as Captured
    expect(await handleTaskDetailRoute(req('/knowledge/x'), fakeRes(cap), fakeSvc(), TOKEN)).toBe(false)
  })

  it('returns false for POST (leaves /tasks/:id/ready to workflow.ts)', async () => {
    const cap = {} as Captured
    expect(await handleTaskDetailRoute(req('/tasks/TASK-1', 'POST'), fakeRes(cap), fakeSvc(), TOKEN)).toBe(false)
  })

  it('returns the full task on GET /tasks/:id', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(), TOKEN)
    expect(cap.status).toBe(200)
    expect((cap.body as Task).body).toMatch(/Acceptance/)
  })

  it('404s an unknown task', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-999'), fakeRes(cap), fakeSvc(), TOKEN)
    expect(cap.status).toBe(404)
  })
})

// TASK-1748 — provenance: which ADR decided this, which files it changed, at
// which commit. Each of the three comes from a different store and none is
// reachable from a graph read, so each gets its own coverage.
describe('handleTaskDetailRoute — TASK-1748 provenance', () => {
  const REAL_FILE = 'src/adapters/companion/task-detail.ts'
  const DELETED_FILE = 'packages/shared/src/index.ts'

  function withFiles(): ProvenanceFixture {
    return {
      touches: [
        { taskId: 'TASK-1', codeRefSlug: 'ref-live', relation: 'modifies' },
        { taskId: 'TASK-1', codeRefSlug: 'ref-dead', relation: 'reference' }
      ],
      codeRefs: {
        'ref-live': { path: REAL_FILE, workspaceId: 'main' },
        'ref-dead': { path: DELETED_FILE, workspaceId: 'main' }
      },
      // This repo — so the live path genuinely resolves and the deleted one
      // genuinely does not, rather than both being stubbed.
      workspaces: { main: process.cwd() }
    }
  }

  it('files[] carries path, workspaceId, relation and a real exists check', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(withFiles()), TOKEN)
    const body = cap.body as { files: Array<Record<string, unknown>> }

    expect(body.files).toEqual([
      { path: REAL_FILE, workspaceId: 'main', relation: 'modifies', exists: true },
      { path: DELETED_FILE, workspaceId: 'main', relation: 'reference', exists: false }
    ])
  })

  it('a commit is tagged with the SESSION\'s workspace, not the project', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      sessions: [
        {
          id: 'SESSION-A',
          taskId: 'TASK-1',
          workspaceId: 'choda-deck-companion',
          handoff: { commits: ['a6ec575 feat(web): shared state primitives'] }
        },
        // A different task's session in the same project must not leak in.
        {
          id: 'SESSION-B',
          taskId: 'TASK-2',
          workspaceId: 'main',
          handoff: { commits: ['deadbee not this task'] }
        }
      ]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)
    const body = cap.body as { commits: Array<Record<string, unknown>> }

    expect(body.commits).toHaveLength(1)
    expect(body.commits[0]).toMatchObject({
      sha: 'a6ec575',
      subject: 'feat(web): shared state primitives',
      workspaceId: 'choda-deck-companion',
      sessionId: 'SESSION-A'
    })
    expect(body.commits[0].workspaceId).not.toBe('main')
  })

  it('adrs[] finds a task named only in ADR prose, not just in frontmatter', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      decisions: [
        // The 38-of-39 case: zero graph edges, zero realizesTasks, prose only.
        { slug: 'ADR-033-deprecate-graphify', title: 'Deprecate graphify', body: 'Supersedes TASK-1 and TASK-991.' },
        // The 1-of-39 case.
        { slug: 'ADR-009-session-lifecycle', title: 'Session lifecycle', body: 'no mention here', realizesTasks: ['TASK-1'] },
        { slug: 'ADR-007-unrelated', title: 'Unrelated', body: 'about something else' }
      ]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)
    const body = cap.body as { adrs: Array<Record<string, unknown>> }

    expect(body.adrs).toEqual([
      { slug: 'ADR-033-deprecate-graphify', title: 'Deprecate graphify', via: 'body' },
      { slug: 'ADR-009-session-lifecycle', title: 'Session lifecycle', via: 'frontmatter' }
    ])
  })

  it('a task id is matched whole — TASK-1 does not match TASK-1597', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      decisions: [{ slug: 'ADR-x', title: 'x', body: 'this ADR is about TASK-1597 only' }]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)
    expect((cap.body as { adrs: unknown[] }).adrs).toEqual([])
  })

  it('commits with zero TOUCHES => undeterminable, NOT "changed no files"', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      sessions: [
        { id: 'SESSION-A', taskId: 'TASK-1', workspaceId: 'main', handoff: { commits: ['abc1234 heredoc edit'] } }
      ]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)
    expect((cap.body as { filesConfidence: string }).filesConfidence).toBe('undeterminable')
  })

  it('commits AND TOUCHES => known; the flag is not just "has commits"', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      ...withFiles(),
      sessions: [
        { id: 'SESSION-A', taskId: 'TASK-1', workspaceId: 'main', handoff: { commits: ['abc1234 real edit'] } }
      ]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)
    expect((cap.body as { filesConfidence: string }).filesConfidence).toBe('known')
  })

  it('no commits and no TOUCHES => known; "changed nothing" is a real answer', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(), TOKEN)
    const body = cap.body as { filesConfidence: string; files: unknown[]; commits: unknown[] }
    expect(body.filesConfidence).toBe('known')
    expect(body.files).toEqual([])
    expect(body.commits).toEqual([])
  })

  it('401s without a bridge token, like /vault/notes', async () => {
    const cap = {} as Captured
    const handled = await handleTaskDetailRoute(
      req('/tasks/TASK-1', 'GET', null),
      fakeRes(cap),
      fakeSvc(withFiles()),
      TOKEN
    )
    expect(handled).toBe(true)
    expect(cap.status).toBe(401)
    // The gate must fire BEFORE any provenance is assembled.
    expect(cap.body).not.toHaveProperty('files')
  })

  it('401s on a wrong token', async () => {
    const cap = {} as Captured
    await handleTaskDetailRoute(req('/tasks/TASK-1', 'GET', 'wrong-token-x'), fakeRes(cap), fakeSvc(), TOKEN)
    expect(cap.status).toBe(401)
  })
})

// Found by running the route against the real database rather than a stub: one
// ADR whose frontmatter failed to parse threw FrontmatterParseError out of
// getKnowledge, the router's catch-all turned it into a 500, and the whole task
// became unreadable. The unit tests could not have caught it — they stubbed the
// service, so nothing ever threw.
describe('handleTaskDetailRoute — provenance must not sink the task read', () => {
  it('an ADR whose frontmatter will not parse is skipped, not fatal', async () => {
    const cap = {} as Captured
    const fx: ProvenanceFixture = {
      decisions: [
        { slug: 'ADR-broken', title: 'Broken', body: 'about TASK-1', unreadable: true },
        { slug: 'ADR-fine', title: 'Fine', body: 'also about TASK-1' }
      ]
    }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)

    expect(cap.status).toBe(200)
    // The readable one still comes through — skipping is per entry, not a
    // bail-out that silently empties the section.
    expect((cap.body as { adrs: Array<{ slug: string }> }).adrs).toEqual([
      { slug: 'ADR-fine', title: 'Fine', via: 'body' }
    ])
  })

  it('ADRs are queried scoped to the task’s own project', async () => {
    // Unscoped, this walks every project's decisions — another project's ADR is
    // not this task's provenance, and entries whose files live in other repos
    // are how the unreadable one reached the loop at all.
    const cap = {} as Captured
    const fx: ProvenanceFixture = { decisions: [] }
    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), fakeSvc(fx), TOKEN)

    expect(fx.seenKnowledgeFilter).toEqual({ type: 'decision', projectId: 'p1' })
  })

  it('a collector throwing outright costs its own section, not the task', async () => {
    const cap = {} as Captured
    const broken = {
      ...fakeSvc(),
      getTouchesForTask: async () => {
        throw new Error('code_ref store unavailable')
      }
    } as unknown as Parameters<typeof handleTaskDetailRoute>[2]

    await handleTaskDetailRoute(req('/tasks/TASK-1'), fakeRes(cap), broken, TOKEN)

    const body = cap.body as { title: string; files: unknown[] };
    expect(cap.status).toBe(200)
    expect(body.title).toBe('graph view')
    expect(body.files).toEqual([])
  })
})
