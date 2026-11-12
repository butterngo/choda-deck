import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import { initSchema } from '../../repositories/schema'
import { EmbeddingStore } from '../embedding-store'
import { runEmbeddingBackfill } from '../embedding-backfill'
import { LOCAL_PROVIDER_ID } from '../local-embedding-provider'
import { noteFrontmatterErrors } from '../knowledge-check'
import { knowledgeCheckCommand } from '../../../../adapters/cli/knowledge-check-command'
import type { EmbeddingProvider } from '../embedding-provider.interface'

// Stands in for the local provider: same id, so the check reads its vectors as current.
class FakeLocalProvider implements EmbeddingProvider {
  readonly id = LOCAL_PROVIDER_ID
  readonly dims = 4
  async embed(text: string): Promise<Float32Array> {
    return Float32Array.from([text.length, 1, 2, 3])
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)))
  }
}

const note = (slug: string, body: string, ref = ''): string =>
  [
    '---',
    'type: decision',
    `title: ${slug}`,
    'projectId: p1',
    'scope: project',
    ref === '' ? 'refs: []' : `refs:\n  - path: src/a.ts\n    commitSha: ${ref}`,
    'createdAt: 2026-01-01',
    'lastVerifiedAt: 2026-01-01',
    '---',
    body,
    ''
  ].join('\n')

let tmpDir: string
let dbPath: string
let db: Database.Database

const addRow = (slug: string, content: string | null): string => {
  const filePath = path.join(tmpDir, `${slug}.md`)
  if (content !== null) fs.writeFileSync(filePath, content)
  db.prepare(
    `INSERT INTO knowledge_index
       (slug, project_id, scope, type, title, file_path, created_at, last_verified_at)
     VALUES (?, 'p1', 'project', 'decision', ?, ?, '2026-01-01', '2026-01-01')`
  ).run(slug, slug, filePath)
  return filePath
}

const embedAll = async (): Promise<void> => {
  const store = new EmbeddingStore(db, true)
  const provider = new FakeLocalProvider()
  store.ensureSchema(provider)
  await runEmbeddingBackfill(store, provider, (p) =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  )
}

const check = async (args: string[] = []): Promise<{ code: number; out: string }> => {
  let out = ''
  const code = await knowledgeCheckCommand(
    args,
    { out: (s) => (out += s), err: (s) => (out += s) },
    dbPath
  )
  return { code, out }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-check-'))
  dbPath = path.join(tmpDir, 'test.db')
  db = new Database(dbPath)
  sqliteVec.load(db)
  initSchema(db)
  db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p1', 'p1', ?)").run(tmpDir)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('knowledge check (TASK-3267)', () => {
  it('exits 0 and lists nothing when every row has a parseable, embedded file', async () => {
    addRow('clean', note('clean', 'a body'))
    await embedAll()
    const { code, out } = await check()
    expect(code).toBe(0)
    expect(out).toContain('checked 1 · orphans 0 · bad frontmatter 0 · stale vectors 0')
  })

  it('lists an orphan, a bad note and a changed file under their own headings and exits 1', async () => {
    addRow('clean', note('clean', 'a body'))
    addRow('gone', note('gone', 'a body'))
    addRow('broken', note('broken', 'a body', ' '))
    const changed = addRow('changed', note('changed', 'the body that was embedded'))
    await embedAll()
    fs.rmSync(path.join(tmpDir, 'gone.md'))
    fs.writeFileSync(changed, note('changed', 'a body edited on disk afterwards'))

    const { code, out } = await check()
    expect(code).toBe(1)
    expect(out).toContain('checked 4 · orphans 1 · bad frontmatter 1 · stale vectors 1')
    const after = (heading: string): string => out.split(heading)[1].split('\n')[1]
    expect(after('orphan rows (file missing) (1):')).toMatch(/^ {2}gone /)
    expect(after('(knowledge_register_existing refuses these) (1):')).toMatch(
      /^ {2}broken: Frontmatter parse: ref missing path or commitSha/
    )
    expect(after('stale vectors (run `choda-deck knowledge backfill`) (1):')).toBe(
      '  changed: file changed'
    )

    const json = JSON.parse((await check(['--json'])).out)
    expect(json.orphans.map((o: { slug: string }) => o.slug)).toEqual(['gone'])
    expect(json.badFrontmatter.map((b: { slug: string }) => b.slug)).toEqual(['broken'])
    expect(json.stale).toEqual([{ slug: 'changed', reason: 'file changed' }])
  })

  it('a row nobody embedded is stale, and the check writes nothing', async () => {
    const file = addRow('fresh', note('fresh', 'a body'))
    const mtime = fs.statSync(file).mtimeMs
    const { code, out } = await check()
    expect(code).toBe(1)
    expect(out).toContain('  fresh: never embedded')
    expect(fs.statSync(file).mtimeMs).toBe(mtime)
    expect(db.prepare('SELECT embedding_provider_id FROM knowledge_index').get()).toEqual({
      embedding_provider_id: null
    })
  })

  it('rejects an unknown argument with exit 2', async () => {
    expect((await check(['--fix'])).code).toBe(2)
  })
})

describe('noteFrontmatterErrors (TASK-3267)', () => {
  const list = (d: string): string[] => fs.readdirSync(d)
  const read = (f: string): string => fs.readFileSync(f, 'utf8')

  it('names a note with an empty commitSha and skips INDEX.md', () => {
    fs.writeFileSync(path.join(tmpDir, 'good.md'), note('good', 'body'))
    fs.writeFileSync(path.join(tmpDir, 'bad.md'), note('bad', 'body', ' '))
    fs.writeFileSync(path.join(tmpDir, 'INDEX.md'), '# not a note\n')
    expect(noteFrontmatterErrors(tmpDir, list, read)).toEqual([
      { file: 'bad.md', reason: 'Frontmatter parse: ref missing path or commitSha' }
    ])
  })

  it('every note committed in docs/knowledge parses', () => {
    expect(noteFrontmatterErrors(path.resolve('docs/knowledge'), list, read)).toEqual([])
  })
})
