import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { initSchema } from './schema'
import { CodeRefRepository } from './code-ref-repository'

let tmpDir: string
let db: Database.Database
let repo: CodeRefRepository
const NOW = '2026-05-31'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coderef-test-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  db.prepare('INSERT INTO projects (id, name, cwd) VALUES (?, ?, ?)').run('pim', 'PIM', tmpDir)
  repo = new CodeRefRepository(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('CodeRefRepository identity + re-pin', () => {
  it('inserts a new row and reads it back', () => {
    const row = repo.upsert(
      {
        slug: 'coderef-product-entity',
        projectId: 'pim',
        workspaceId: 'pim-trading-api',
        path: 'Domain/Product.cs',
        symbol: 'Ichiba.Pim.TradingCatalog.Domain.Product',
        lineHint: 42,
        commitSha: 'sha-1'
      },
      NOW
    )
    expect(row.slug).toBe('coderef-product-entity')
    expect(repo.get('coderef-product-entity')?.symbol).toBe(
      'Ichiba.Pim.TradingCatalog.Domain.Product'
    )
  })

  it('re-pins SHA on a duplicate identity instead of inserting a new row', () => {
    repo.upsert(
      { slug: 'first', projectId: 'pim', path: 'Domain/Product.cs', symbol: 'A.B.C', commitSha: 'old' },
      NOW
    )
    const second = repo.upsert(
      // Different slug, SAME identity tuple → must UPDATE the original row.
      { slug: 'second', projectId: 'pim', path: 'Domain/Product.cs', symbol: 'A.B.C', commitSha: 'new' },
      '2026-06-01'
    )
    expect(second.slug).toBe('first') // original slug retained
    expect(second.commitSha).toBe('new') // SHA re-pinned
    expect(second.lastVerifiedAt).toBe('2026-06-01')
    expect(repo.get('second')).toBeNull() // no second row created
    const all = repo.listByPrefix({ projectId: 'pim' })
    expect(all).toHaveLength(1)
  })

  it('treats NULL symbol as identity-distinct from a non-null symbol on the same path', () => {
    repo.upsert({ slug: 'file-level', projectId: 'pim', path: 'page.tsx' }, NOW)
    repo.upsert({ slug: 'symbol-level', projectId: 'pim', path: 'page.tsx', symbol: 'X.Y' }, NOW)
    expect(repo.listByPrefix({ projectId: 'pim', path: 'page.tsx' })).toHaveLength(2)
  })

  it('collapses two file-level (NULL symbol) writes to one row', () => {
    repo.upsert({ slug: 'a', projectId: 'pim', path: 'page.tsx', commitSha: 's1' }, NOW)
    const b = repo.upsert({ slug: 'b', projectId: 'pim', path: 'page.tsx', commitSha: 's2' }, NOW)
    expect(b.slug).toBe('a')
    expect(b.commitSha).toBe('s2')
  })
})

describe('CodeRefRepository prefix query', () => {
  beforeEach(() => {
    repo.upsert(
      { slug: 'd1', projectId: 'pim', path: 'Domain/Product.cs', symbol: 'Ichiba.Pim.Domain.Product' },
      NOW
    )
    repo.upsert(
      { slug: 'd2', projectId: 'pim', path: 'Domain/Seller.cs', symbol: 'Ichiba.Pim.Domain.Seller' },
      NOW
    )
    repo.upsert(
      { slug: 'a1', projectId: 'pim', path: 'App/Handler.cs', symbol: 'Ichiba.Pim.Application.Handler' },
      NOW
    )
  })

  it('returns only symbols under the requested prefix', () => {
    const domain = repo.listByPrefix({ projectId: 'pim', symbolPrefix: 'Ichiba.Pim.Domain.' })
    expect(domain.map((r) => r.slug).sort()).toEqual(['d1', 'd2'])
  })

  it('lists the whole project with no filter', () => {
    expect(repo.listByPrefix({ projectId: 'pim' })).toHaveLength(3)
  })
})

describe('TOUCHES edges', () => {
  beforeEach(() => {
    repo.upsert({ slug: 'cr-a', projectId: 'pim', path: 'a.cs' }, NOW)
    repo.upsert({ slug: 'cr-b', projectId: 'pim', path: 'b.cs' }, NOW)
  })

  it('adds edges with a required relation and reads them per task', () => {
    repo.addTouches('TASK-914', 'cr-a', 'modifies')
    repo.addTouches('TASK-914', 'cr-b', 'modifies')
    const edges = repo.getTouchesForTask('TASK-914')
    const modifies = edges.filter((e) => e.relation === 'modifies')
    const reference = edges.filter((e) => e.relation === 'reference')
    expect(modifies).toHaveLength(2)
    expect(reference).toHaveLength(0)
  })

  it('overwrites the relation when the same edge is re-added', () => {
    repo.addTouches('TASK-1', 'cr-a', 'reference')
    repo.addTouches('TASK-1', 'cr-a', 'modifies')
    const edges = repo.getTouchesForTask('TASK-1')
    expect(edges).toHaveLength(1)
    expect(edges[0].relation).toBe('modifies')
  })

  it('rejects a relation outside the CHECK set', () => {
    expect(() =>
      db
        .prepare('INSERT INTO task_code_refs (task_id, code_ref_slug, relation) VALUES (?, ?, ?)')
        .run('TASK-2', 'cr-a', 'deletes')
    ).toThrow()
  })

  it('removes edges when the code_ref is deleted', () => {
    repo.addTouches('TASK-3', 'cr-a', 'modifies')
    repo.delete('cr-a')
    expect(repo.getTouchesForTask('TASK-3')).toHaveLength(0)
    expect(repo.get('cr-a')).toBeNull()
  })
})
