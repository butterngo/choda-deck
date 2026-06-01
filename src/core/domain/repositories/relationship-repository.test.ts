import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initSchema } from './schema'
import { RelationshipRepository } from './relationship-repository'

let tmpDir: string
let db: Database.Database
let repo: RelationshipRepository

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relrepo-test-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  repo = new RelationshipRepository(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('RelationshipRepository directional queries', () => {
  it('getTo returns inbound edges, getFrom outbound, filtered by type', () => {
    repo.add('TASK-1', 'feature-x', 'REALIZES')
    repo.add('TASK-2', 'feature-x', 'REALIZES')
    repo.add('feature-x', 'ws-be', 'IN')
    repo.add('gotcha-1', 'feature-x', 'ABOUT')

    const realizers = repo.getTo('feature-x', 'REALIZES')
    expect(realizers.map((e) => e.fromId).sort()).toEqual(['TASK-1', 'TASK-2'])

    const inWorkspaces = repo.getFrom('feature-x', 'IN')
    expect(inWorkspaces.map((e) => e.toId)).toEqual(['ws-be'])

    const about = repo.getTo('feature-x', 'ABOUT')
    expect(about.map((e) => e.fromId)).toEqual(['gotcha-1'])
  })

  it('getTo without a type returns every inbound edge regardless of type', () => {
    repo.add('TASK-1', 'feature-x', 'REALIZES')
    repo.add('gotcha-1', 'feature-x', 'ABOUT')
    expect(repo.getTo('feature-x')).toHaveLength(2)
  })
})

describe('All five ADR-NNN edge types round-trip through the generic table', () => {
  it('stores and reads REALIZES / ABOUT / PINS / IN / INTEGRATES_WITH', () => {
    repo.add('TASK-9', 'feature-a', 'REALIZES')
    repo.add('gotcha-a', 'feature-a', 'ABOUT')
    repo.add('decision-a', 'coderef-a', 'PINS')
    repo.add('feature-a', 'ws-api', 'IN')
    repo.add('ws-api', 'ws-portal', 'INTEGRATES_WITH')

    expect(repo.getTo('feature-a', 'REALIZES')[0].fromId).toBe('TASK-9')
    expect(repo.getTo('feature-a', 'ABOUT')[0].fromId).toBe('gotcha-a')
    expect(repo.getTo('coderef-a', 'PINS')[0].fromId).toBe('decision-a')
    expect(repo.getFrom('feature-a', 'IN')[0].toId).toBe('ws-api')
    expect(repo.getFrom('ws-api', 'INTEGRATES_WITH')[0].toId).toBe('ws-portal')
  })

  it('adding the same edge twice is idempotent (PK on from_id, to_id, type)', () => {
    repo.add('feature-a', 'ws-api', 'IN')
    repo.add('feature-a', 'ws-api', 'IN')
    expect(repo.getFrom('feature-a', 'IN')).toHaveLength(1)
  })

  it('same node pair under two edge types are distinct rows', () => {
    repo.add('a', 'b', 'IN')
    repo.add('a', 'b', 'INTEGRATES_WITH')
    expect(repo.getFrom('a')).toHaveLength(2)
  })
})

// AC bullet 3 — the exact pilot answers for feature-crawler-list-ui-enhancements
// once migrate-992-pilot-edges.mjs has populated edges from the frontmatter.
describe('Pilot feature traversal (feature-crawler-list-ui-enhancements)', () => {
  const FEATURE = 'feature-crawler-list-ui-enhancements'
  const REALIZE_TASKS = [
    'TASK-909',
    'TASK-910',
    'TASK-914',
    'TASK-915',
    'TASK-916',
    'TASK-917',
    'TASK-918'
  ]
  const WORKSPACES = ['pim-trading-api', 'remote-pim-portal']
  const GOTCHAS = [
    'gotcha-917-split-from-909',
    'gotcha-logo-source-of-truth-option-b',
    'gotcha-seller-name-not-captured',
    'gotcha-six-source-enums-removed'
  ]

  beforeEach(() => {
    for (const t of REALIZE_TASKS) repo.add(t, FEATURE, 'REALIZES')
    for (const w of WORKSPACES) repo.add(FEATURE, w, 'IN')
    for (const g of GOTCHAS) repo.add(g, FEATURE, 'ABOUT')
  })

  it('answers "which tasks realize this feature?" → 7 task IDs', () => {
    expect(repo.getTo(FEATURE, 'REALIZES').map((e) => e.fromId).sort()).toEqual(REALIZE_TASKS)
  })

  it('answers "which workspaces is it in?" → 2', () => {
    expect(repo.getFrom(FEATURE, 'IN').map((e) => e.toId).sort()).toEqual(WORKSPACES)
  })

  it('answers "what gotchas are about this feature?" → 4', () => {
    expect(repo.getTo(FEATURE, 'ABOUT').map((e) => e.fromId).sort()).toEqual(GOTCHAS)
  })
})
