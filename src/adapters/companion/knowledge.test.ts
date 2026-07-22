// TASK-1172 — integration: boot the adapter, hit /knowledge, /knowledge/:slug,
// /knowledge/search, /graph/edges; assert shapes + bad-request guards.

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { KnowledgeEntry, KnowledgeListItem } from '../../core/domain/knowledge-types'
import type { Relationship } from '../../core/domain/task-types'
import { LEDGER_ENTITIES } from './sync-ledger'
import { ensureLoopStatusColumns } from '../../core/sync/sync-loop-status'
import { createSyncEventsTable } from '../../core/sync/sync-events'

function fixtureDb(): Database.Database {
  const db = new Database(':memory:')
  for (const { table } of LEDGER_ENTITIES) {
    db.exec(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, sync_origin TEXT, sync_updated_at INTEGER, sync_deleted_at INTEGER)`
    )
  }
  db.exec(
    `CREATE TABLE _sync_state (id INTEGER PRIMARY KEY CHECK (id = 0), last_pull_at INTEGER NOT NULL DEFAULT 0)`
  )
  db.exec('INSERT INTO _sync_state (id, last_pull_at) VALUES (0, 0)')
  ensureLoopStatusColumns(db)
  createSyncEventsTable(db)
  return db
}

const listItem = (slug: string): KnowledgeListItem => ({
  slug,
  projectId: 'p1',
  workspaceId: null,
  scope: 'project',
  type: 'gotcha',
  title: `Title of ${slug}`,
  filePath: `docs/knowledge/${slug}.md`,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastVerifiedAt: '2026-01-01T00:00:00.000Z'
})

const entry = (slug: string): KnowledgeEntry => ({
  slug,
  frontmatter: listItem(slug),
  body: `body of ${slug}`,
  filePath: `docs/knowledge/${slug}.md`,
  staleness: [{ path: 'src/x.ts', commitSha: 'abc123', commitsSince: 0 }],
  isStale: false
})

// Stateful fake covering exactly the surface the knowledge/graph routes touch.
function fakeKnowledgeSvc(): BackendTaskService {
  const entries = new Map<string, KnowledgeEntry>([['gotcha-1', entry('gotcha-1')]])
  const relationships: Relationship[] = [
    { fromId: 'TASK-1', toId: 'TASK-2', type: 'DEPENDS_ON' },
    { fromId: 'TASK-3', toId: 'TASK-1', type: 'REALIZES' }
  ]
  return {
    getKnowledge: async (slug: string) => entries.get(slug) ?? null,
    listKnowledge: async () => [...entries.values()].map((e) => listItem(e.slug)),
    searchKnowledge: async () => ({
      enabled: false,
      reason: 'embedding store not configured',
      results: []
    }),
    getRelationships: async (itemId: string) =>
      relationships.filter((r) => r.fromId === itemId || r.toId === itemId),
    getRelationshipsFrom: async (itemId: string, type?: string) =>
      relationships.filter((r) => r.fromId === itemId && (!type || r.type === type)),
    getRelationshipsTo: async (itemId: string, type?: string) =>
      relationships.filter((r) => r.toId === itemId && (!type || r.type === type))
  } as unknown as BackendTaskService
}

describe('knowledge + graph routes (integration)', () => {
  it('serves knowledge list/get/search and graph edges, with bad-request guards', async () => {
    const db = fixtureDb()
    const services: CompanionServices = {
      svc: fakeKnowledgeSvc(),
      db,
      dbPath: ':memory:',
      intervalMs: 30000,
      bridgeToken: 'tok',
      pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
      push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
      close: () => db.close()
    }
    const handle = await startCompanionServer(services, 0)
    const base = `http://${COMPANION_BIND}:${handle.address.port}`
    try {
      // AC-1 — list + get
      const list = await (await fetch(`${base}/knowledge`)).json()
      expect(list.entries.map((e: KnowledgeListItem) => e.slug)).toEqual(['gotcha-1'])
      expect((await fetch(`${base}/knowledge?type=bogus`)).status).toBe(400)

      const got = await (await fetch(`${base}/knowledge/gotcha-1`)).json()
      expect(got.slug).toBe('gotcha-1')
      expect(got.isStale).toBe(false)
      expect(got.staleness).toHaveLength(1)
      expect((await fetch(`${base}/knowledge/nope`)).status).toBe(404)

      // AC-2 — search degrades gracefully (never throws/500s) when embeddings are off
      const search = await (await fetch(`${base}/knowledge/search?q=cap`)).json()
      expect(search.enabled).toBe(false)
      expect(search.results).toEqual([])
      expect((await fetch(`${base}/knowledge/search`)).status).toBe(400)
      expect((await fetch(`${base}/knowledge/search?q=cap&topK=999`)).status).toBe(400)

      // AC-3 — graph edges, direction + type filters
      const both = await (await fetch(`${base}/graph/edges?node=TASK-1`)).json()
      expect(both.edges).toHaveLength(2)
      const out = await (await fetch(`${base}/graph/edges?node=TASK-1&direction=out`)).json()
      expect(out.edges.map((e: Relationship) => e.toId)).toEqual(['TASK-2'])
      const inn = await (await fetch(`${base}/graph/edges?node=TASK-1&direction=in&type=REALIZES`)).json()
      expect(inn.edges.map((e: Relationship) => e.fromId)).toEqual(['TASK-3'])
      expect((await fetch(`${base}/graph/edges`)).status).toBe(400)
      expect((await fetch(`${base}/graph/edges?node=TASK-1&type=bogus`)).status).toBe(400)
      expect((await fetch(`${base}/graph/edges?node=TASK-1&direction=sideways`)).status).toBe(400)
    } finally {
      await handle.close()
      db.close()
    }
  })
})
