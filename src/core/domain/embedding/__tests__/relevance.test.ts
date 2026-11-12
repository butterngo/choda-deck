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
import { KnowledgeLexicalIndex } from '../lexical-index'
import { NO_MATCH_DISTANCE, hasConfidentMatch, sweepCuts } from '../relevance'
import type { EmbeddingProvider } from '../embedding-provider.interface'
import type { GitOps } from '../../knowledge-git'

describe('sweepCuts (TASK-1622)', () => {
  const rows = [
    { id: 'm1', shouldMatch: true, signals: { nearestDistance: 1.0, lexicalMatches: 1 } },
    { id: 'm2', shouldMatch: true, signals: { nearestDistance: 1.1, lexicalMatches: 0 } },
    { id: 'x1', shouldMatch: false, signals: { nearestDistance: 1.2, lexicalMatches: 2 } }
  ]

  it('counts false negatives below the band and false positives above it', () => {
    const at = (rule: string, cut: number): [number, number] => {
      const l = sweepCuts(rows, [cut]).find((x) => x.rule === rule)!
      return [l.falsePositives, l.falseNegatives]
    }
    expect(at('distance', 1.05)).toEqual([0, 1])
    expect(at('distance', 1.15)).toEqual([0, 0])
    expect(at('distance', 1.25)).toEqual([1, 0])
    // a lexical match marks the nonsense row confident at any cut
    expect(at('distance-or-lexical', 1.15)).toEqual([1, 0])
  })

  it('hasConfidentMatch follows the distance cut only', () => {
    expect(hasConfidentMatch({ nearestDistance: NO_MATCH_DISTANCE, lexicalMatches: 0 })).toBe(true)
    expect(hasConfidentMatch({ nearestDistance: NO_MATCH_DISTANCE + 0.01, lexicalMatches: 5 })).toBe(
      false
    )
    expect(hasConfidentMatch({ nearestDistance: null, lexicalMatches: 0 })).toBe(false)
  })
})

// Unit vectors on three axes: text naming the heron is one axis, any other
// entry text (title + blank line + body) a second, any other query a third.
// Off-axis distance is √2 (1.414), past NO_MATCH_DISTANCE.
class AxisProvider implements EmbeddingProvider {
  readonly id = 'axis-test'
  readonly dims = 3
  async embed(text: string): Promise<Float32Array> {
    if (text.includes('heron')) return Float32Array.from([1, 0, 0])
    return text.includes('\n\n') ? Float32Array.from([0, 1, 0]) : Float32Array.from([0, 0, 1])
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
let svc: KnowledgeService

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevance-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  sqliteVec.load(db)
  initSchema(db)
  const projects = new ProjectRepository(db)
  fs.mkdirSync(path.join(tmpDir, 'p1'))
  projects.ensure('p1', 'p1', path.join(tmpDir, 'p1'))
  const store = new EmbeddingStore(db, true)
  const provider = new AxisProvider()
  store.ensureSchema(provider)
  svc = new KnowledgeService({
    knowledge: new KnowledgeRepository(db),
    projects,
    git,
    contentRoot: path.join(tmpDir, 'vault'),
    now: () => new Date('2026-05-04T00:00:00Z'),
    embeddingStore: store,
    embeddingProvider: async () => provider,
    lexicalIndex: new KnowledgeLexicalIndex(db)
  })
  for (const [slug, body] of [
    ['birds', 'the heron waits in the shallows'],
    ['fish', 'a carp in the pond'],
    ['trees', 'oak and ash']
  ]) {
    await svc.createKnowledge({
      projectId: 'p1',
      type: 'decision',
      scope: 'project',
      title: slug,
      body,
      refs: [],
      slug
    })
  }
  await new Promise((r) => setTimeout(r, 60))
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('knowledge_search relevance flags (TASK-1622)', () => {
  it('a nonsense query is flagged noConfidentMatch and keeps every result', async () => {
    const r = await svc.searchKnowledge('zzzqqqxyzzy', 5)
    expect(r.noConfidentMatch).toBe(true)
    expect(r.results).toHaveLength(3)
    expect(r.results.every((h) => h.weak)).toBe(true)
  })

  it('a matching query is not flagged, and only its far hits are weak', async () => {
    const r = await svc.searchKnowledge('heron', 5)
    expect(r.noConfidentMatch).toBe(false)
    expect(r.results).toHaveLength(3)
    expect(r.results[0].slug).toBe('birds')
    expect(r.results[0].weak).toBe(false)
    expect(r.results.slice(1).every((h) => h.weak)).toBe(true)
  })
})
