import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { initSchema } from '../../repositories/schema'
import { ProjectRepository } from '../../repositories/project-repository'
import { KnowledgeRepository } from '../../repositories/knowledge-repository'
import { KnowledgeService } from '../../knowledge-service'
import { EmbeddingStore } from '../embedding-store'
import { runEmbeddingBackfill } from '../embedding-backfill'
import type { EmbeddingProvider } from '../embedding-provider.interface'
import type { GitOps } from '../../knowledge-git'

// Counts every text it embeds, so a test can say exactly which rows ran.
class CountingProvider implements EmbeddingProvider {
  readonly dims = 4
  readonly embedded: string[] = []
  constructor(readonly id: string) {}
  async embed(text: string): Promise<Float32Array> {
    this.embedded.push(text)
    return Float32Array.from([text.length, 1, 2, 3])
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)))
  }
}

const git: GitOps = {
  getHeadSha: () => 'sha',
  countCommitsSince: () => 0,
  isAncestor: () => true,
  filesInCommit: () => []
}

let tmpDir: string
let db: Database.Database
let store: EmbeddingStore

const read = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

const addRow = (slug: string, body: string | null): string => {
  const filePath = path.join(tmpDir, `${slug}.md`)
  if (body !== null) fs.writeFileSync(filePath, `---\ntitle: ${slug}\n---\n${body}\n`)
  db.prepare(
    `INSERT INTO knowledge_index
       (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
     VALUES (?, 'p1', 'project', 'decision', ?, ?, '2026-01-01', '2026-01-01')`
  ).run(slug, slug, filePath)
  return filePath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-backfill-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  sqliteVec.load(db)
  initSchema(db)
  db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'p1', ?)").run(tmpDir)
  store = new EmbeddingStore(db, true)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runEmbeddingBackfill (TASK-3261)', () => {
  it('re-embeds exactly the row whose file was edited on disk', async () => {
    const provider = new CountingProvider('p-a')
    store.ensureSchema(provider)
    addRow('one', 'first body')
    const twoPath = addRow('two', 'second body')
    await runEmbeddingBackfill(store, provider, read)

    fs.writeFileSync(twoPath, '---\ntitle: two\n---\nsecond body, edited by hand\n')
    const report = await runEmbeddingBackfill(store, provider, read)

    expect(report.embedded).toEqual(['two'])
    expect(report.unchanged).toBe(1)
  })

  it('embeds nothing on a second run when no file changed', async () => {
    const provider = new CountingProvider('p-a')
    store.ensureSchema(provider)
    addRow('one', 'first body')
    addRow('two', 'second body')

    const first = await runEmbeddingBackfill(store, provider, read)
    const second = await runEmbeddingBackfill(store, provider, read)

    expect(first.embedded).toEqual(['one', 'two'])
    expect(second.embedded).toEqual([])
    expect(second.unchanged).toBe(2)
  })

  it('reports a row whose file is gone as an orphan, not a failure', async () => {
    const provider = new CountingProvider('p-a')
    store.ensureSchema(provider)
    addRow('here', 'present body')
    const gone = addRow('gone', null)

    const report = await runEmbeddingBackfill(store, provider, read)

    expect(report.orphans).toEqual([{ slug: 'gone', filePath: gone }])
    expect(report.failed).toEqual([])
    expect(report.embedded).toEqual(['here'])
  })

  it('re-embeds every row when the provider changes', async () => {
    const a = new CountingProvider('p-a')
    store.ensureSchema(a)
    addRow('one', 'first body')
    await runEmbeddingBackfill(store, a, read)

    const b = new CountingProvider('p-b')
    store.ensureSchema(b)
    const report = await runEmbeddingBackfill(store, b, read)

    expect(report.embedded).toEqual(['one'])
  })

  // The write path and the backfill must agree on what text a vector stands
  // for, or every entry written through the service would be re-embedded by
  // the next backfill for no reason.
  it('finds nothing to do for entries the service embedded on write', async () => {
    const provider = new CountingProvider('p-a')
    store.ensureSchema(provider)
    const svc = new KnowledgeService({
      knowledge: new KnowledgeRepository(db),
      projects: new ProjectRepository(db),
      git,
      contentRoot: path.join(tmpDir, 'vault'),
      now: () => new Date('2026-05-04T00:00:00Z'),
      embeddingStore: store,
      embeddingProvider: async () => provider
    })
    await svc.createKnowledge({
      projectId: 'p1',
      type: 'decision',
      scope: 'project',
      title: 'Written through the service',
      body: '## Heading\n\nSome body text.\n',
      refs: [],
      slug: 'via-service'
    })
    await new Promise((r) => setTimeout(r, 50))

    const report = await runEmbeddingBackfill(store, provider, read)

    expect(report.embedded).toEqual([])
    expect(report.unchanged).toBe(1)
  })
})
