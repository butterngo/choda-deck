import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIXTURE,
  knowledgeEvalCommand,
  type KnowledgeEvalDeps
} from './knowledge-eval-command'

function capture(): {
  out: string[]
  err: string[]
  io: { out: (s: string) => void; err: (s: string) => void }
} {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } }
}

const deps: KnowledgeEvalDeps = {
  search: async () => [{ slug: 'a', distance: 1 }],
  lookup: async (slug) => (slug === 'a' ? { title: 'Alpha note', body: 'uses `fooBar`' } : null),
  disabledReason: async () => null
}

function writeFixture(queries: unknown[]): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keval-')), 'q.json')
  fs.writeFileSync(p, JSON.stringify({ queries }))
  return p
}

describe('knowledgeEvalCommand', () => {
  it('exits 2 on an unknown argument and on a missing fixture file', async () => {
    const c = capture()
    expect(await knowledgeEvalCommand(['--bogus'], c.io, deps)).toBe(2)
    expect(await knowledgeEvalCommand(['--fixture', 'nope.json'], c.io, deps)).toBe(2)
    expect(c.err.join('')).toContain('file not found: nope.json')
  })

  it('exits 1 and lists every problem when the fixture does not match the store', async () => {
    const c = capture()
    const p = writeFixture([{ id: 'x', class: 'identifier', query: 'fooBar', expect: ['gone'] }])
    expect(await knowledgeEvalCommand(['--fixture', p], c.io, deps)).toBe(1)
    expect(c.err.join('')).toContain('x: expected slug "gone" is not in knowledge_index')
    expect(c.err.join('')).toContain('needs at least 30')
  })

  it('exits 1 without running queries when search is disabled', async () => {
    const queries = [
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `i${i}`,
        class: 'identifier',
        query: 'fooBar',
        expect: ['a']
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `p${i}`,
        class: 'paraphrase',
        query: 'first letter',
        expect: ['a']
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `n${i}`,
        class: 'nonsense',
        query: 'zzz',
        expect: []
      }))
    ]
    const p = writeFixture(queries)
    const c = capture()
    let searched = 0
    const disabled: KnowledgeEvalDeps = {
      ...deps,
      search: async () => {
        searched++
        return []
      },
      disabledReason: async () => 'embedding store not configured'
    }
    expect(await knowledgeEvalCommand(['--fixture', p], c.io, disabled)).toBe(1)
    expect(searched).toBe(0)
    const ok = capture()
    expect(await knowledgeEvalCommand(['--fixture', p, '--perturb', 'reverse'], ok.io, deps)).toBe(
      0
    )
    expect(ok.out.join('')).toContain('perturb reverse')
  })

  it('the committed live fixture is at the default path', () => {
    expect(fs.existsSync(DEFAULT_FIXTURE)).toBe(true)
  })
})
