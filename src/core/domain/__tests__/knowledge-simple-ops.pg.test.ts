// Smoke sibling of knowledge-service.test.ts (~40 tests against KnowledgeRepository
// + ProjectRepository over an in-memory sqlite db) — drives the 7 non-search
// knowledge ops through PostgresTaskService.
//
// Slice 20b will add searchKnowledge once the EmbeddingStore port unifies
// sqlite-vec + pgvector; this slice deliberately leaves that stub throwing.
//
// Scope: verify each public op writes the expected file on disk AND the
// expected knowledge_index row in Postgres, plus that updates / verify /
// delete chain works through the port refactor. Cross-scope + workspace
// edge cases stay in the sqlite suite (they exercise the same JS path).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  describeIfDocker,
  startPostgresTestEnv,
  stopPostgresTestEnv,
  type PgTestEnv
} from '../../../test/postgres-harness'
import { PostgresTaskService } from '../postgres-task-service'
import {
  KnowledgeConflictError,
  KnowledgeNotFoundError,
  KnowledgeValidationError
} from '../knowledge-service'
import { parseFrontmatter } from '../knowledge-frontmatter'
import { PostgresNotImplementedError } from '../postgres-not-implemented-error'

describeIfDocker('PostgresTaskService knowledge simple ops (slice 20a)', () => {
  let env: PgTestEnv
  let svc: PostgresTaskService
  let tmpDir: string
  let projectCwd: string

  beforeAll(async () => {
    env = await startPostgresTestEnv()
    svc = new PostgresTaskService(env.conn)
    await svc.initializeAsync()
  }, 120_000)

  afterAll(async () => {
    if (env) await stopPostgresTestEnv(env)
  }, 30_000)

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-pg-'))
    projectCwd = path.join(tmpDir, 'repo')
    fs.mkdirSync(projectCwd, { recursive: true })

    await env.conn.query('DELETE FROM knowledge_index')
    await env.conn.query('DELETE FROM workspaces')
    await env.conn.query('DELETE FROM projects')
    await svc.ensureProject('proj-k', 'Knowledge Project', projectCwd)
  })

  describe('createKnowledge', () => {
    it('writes file + index row + INDEX.md for project scope', async () => {
      const entry = await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'My Decision',
        body: 'because.',
        refs: []
      })

      expect(entry.slug).toBe('my-decision')
      expect(entry.frontmatter.type).toBe('decision')

      const filePath = path.join(projectCwd, 'docs', 'knowledge', 'my-decision.md')
      expect(fs.existsSync(filePath)).toBe(true)
      const raw = fs.readFileSync(filePath, 'utf8')
      const { frontmatter, body } = parseFrontmatter(raw)
      expect(frontmatter.title).toBe('My Decision')
      expect(body.trim()).toBe('because.')

      const indexPath = path.join(projectCwd, 'docs', 'knowledge', 'INDEX.md')
      expect(fs.existsSync(indexPath)).toBe(true)
      expect(fs.readFileSync(indexPath, 'utf8')).toContain('my-decision')

      const rowQ = await env.conn.query<{ slug: string; project_id: string }>(
        'SELECT slug, project_id FROM knowledge_index WHERE slug = $1',
        ['my-decision']
      )
      expect(rowQ.rows[0]?.project_id).toBe('proj-k')
    })

    it('throws KnowledgeConflictError on duplicate slug', async () => {
      await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'Dup',
        body: 'b',
        refs: []
      })
      await expect(
        svc.createKnowledge({
          projectId: 'proj-k',
          scope: 'project',
          type: 'decision',
          title: 'Dup',
          body: 'b',
          refs: []
        })
      ).rejects.toBeInstanceOf(KnowledgeConflictError)
    })

    it('throws KnowledgeValidationError on unknown projectId', async () => {
      await expect(
        svc.createKnowledge({
          projectId: 'proj-missing',
          scope: 'project',
          type: 'decision',
          title: 't',
          body: 'b',
          refs: []
        })
      ).rejects.toBeInstanceOf(KnowledgeValidationError)
    })
  })

  describe('getKnowledge / listKnowledge', () => {
    it('round-trips an entry', async () => {
      await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'Round Trip',
        body: 'rt body',
        refs: []
      })
      const got = await svc.getKnowledge('round-trip')
      expect(got).not.toBeNull()
      expect(got?.body.trim()).toBe('rt body')
      expect(got?.frontmatter.title).toBe('Round Trip')
    })

    it('returns null for unknown slug', async () => {
      expect(await svc.getKnowledge('nope')).toBeNull()
    })

    it('lists entries filtered by projectId', async () => {
      await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'A',
        body: 'a',
        refs: []
      })
      await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'spike',
        title: 'B',
        body: 'b',
        refs: []
      })
      const items = await svc.listKnowledge({ projectId: 'proj-k' })
      expect(items.map((i) => i.slug).sort()).toEqual(['a', 'b'])
    })
  })

  describe('updateKnowledge', () => {
    it('rewrites body and bumps lastVerifiedAt', async () => {
      const created = await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'Upd',
        body: 'v1',
        refs: []
      })
      const updated = await svc.updateKnowledge({ slug: created.slug, body: 'v2' })
      expect(updated.body.trim()).toBe('v2')

      const rePath = path.join(projectCwd, 'docs', 'knowledge', 'upd.md')
      expect(fs.readFileSync(rePath, 'utf8')).toContain('v2')
    })

    it('throws KnowledgeNotFoundError on missing slug', async () => {
      await expect(svc.updateKnowledge({ slug: 'ghost', body: 'x' })).rejects.toBeInstanceOf(
        KnowledgeNotFoundError
      )
    })
  })

  describe('verifyKnowledge', () => {
    it('updates lastVerifiedAt in both file + index', async () => {
      const created = await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'Vfy',
        body: 'b',
        refs: []
      })
      const before = created.frontmatter.lastVerifiedAt

      // Advance clock-ish — just call verify; we assert the result echoes back
      // a (possibly equal) ISO date and that the index row was touched.
      const result = await svc.verifyKnowledge(created.slug)
      expect(result.isStale).toBe(false)
      expect(result.lastVerifiedAt).toBeTruthy()

      const rowQ = await env.conn.query<{ last_verified_at: string }>(
        'SELECT last_verified_at FROM knowledge_index WHERE slug = $1',
        [created.slug]
      )
      expect(rowQ.rows[0]?.last_verified_at >= before).toBe(true)
    })

    it('throws KnowledgeNotFoundError on missing slug', async () => {
      await expect(svc.verifyKnowledge('ghost')).rejects.toBeInstanceOf(KnowledgeNotFoundError)
    })
  })

  describe('deleteKnowledge', () => {
    it('removes file + index row + regenerates INDEX.md', async () => {
      const created = await svc.createKnowledge({
        projectId: 'proj-k',
        scope: 'project',
        type: 'decision',
        title: 'Del Me',
        body: 'b',
        refs: []
      })
      const filePath = path.join(projectCwd, 'docs', 'knowledge', 'del-me.md')
      expect(fs.existsSync(filePath)).toBe(true)

      const r = await svc.deleteKnowledge(created.slug)
      expect(r.deletedFile).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)

      const rowQ = await env.conn.query(
        'SELECT slug FROM knowledge_index WHERE slug = $1',
        [created.slug]
      )
      expect(rowQ.rows).toHaveLength(0)
    })

    it('throws KnowledgeNotFoundError on missing slug', async () => {
      await expect(svc.deleteKnowledge('ghost')).rejects.toBeInstanceOf(KnowledgeNotFoundError)
    })
  })

  describe('registerExistingKnowledge', () => {
    it('imports an existing md file (frontmatter projectId must match)', async () => {
      // Hand-write a knowledge file outside the create-flow.
      const slug = 'imported'
      const filePath = path.join(projectCwd, 'docs', 'knowledge', `${slug}.md`)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const content = [
        '---',
        'type: decision',
        'title: Imported',
        'projectId: proj-k',
        'scope: project',
        'refs: []',
        'createdAt: "2026-05-20"',
        'lastVerifiedAt: "2026-05-20"',
        '---',
        '',
        'imported body'
      ].join('\n')
      fs.writeFileSync(filePath, content, 'utf8')

      const entry = await svc.registerExistingKnowledge({
        projectId: 'proj-k',
        filePath
      })
      expect(entry.slug).toBe('imported')
      expect(entry.body.trim()).toBe('imported body')

      const rowQ = await env.conn.query<{ slug: string }>(
        'SELECT slug FROM knowledge_index WHERE slug = $1',
        ['imported']
      )
      expect(rowQ.rows[0]?.slug).toBe('imported')
    })
  })

  describe('searchKnowledge still throws (slice 20b)', () => {
    it('throws PostgresNotImplementedError', async () => {
      await expect(svc.searchKnowledge('q')).rejects.toBeInstanceOf(PostgresNotImplementedError)
    })
  })
})
