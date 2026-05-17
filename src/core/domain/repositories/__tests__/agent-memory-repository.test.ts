import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../schema'
import { AgentMemoryRepository } from '../agent-memory-repository'

let tmpDir: string
let db: Database.Database
let memories: AgentMemoryRepository

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mem-repo-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  memories = new AgentMemoryRepository(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('AgentMemoryRepository.create', () => {
  it('inserts and returns the memory with defaults', () => {
    const mem = memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'Deployed to prod successfully'
    })
    expect(mem.scopeType).toBe('project')
    expect(mem.scopeId).toBe('p1')
    expect(mem.memoryType).toBe('episodic')
    expect(mem.content).toBe('Deployed to prod successfully')
    expect(mem.importance).toBe(50)
    expect(mem.tags).toEqual([])
    expect(mem.recallCount).toBe(0)
    expect(mem.lastRecalledAt).toBeNull()
    expect(mem.sourceSessionId).toBeNull()
    expect(mem.sourceEventIds).toEqual([])
    expect(mem.id).toBeTruthy()
    expect(mem.createdAt).toBeTruthy()
  })

  it('stores tags, importance, and sourceEventIds', () => {
    const mem = memories.create({
      scopeType: 'task',
      scopeId: 't1',
      memoryType: 'procedural',
      content: 'Always run lint before commit',
      tags: ['lint', 'workflow'],
      importance: 80,
      sourceSessionId: 'S1',
      sourceEventIds: ['EVT-1', 'EVT-2']
    })
    expect(mem.tags).toEqual(['lint', 'workflow'])
    expect(mem.importance).toBe(80)
    expect(mem.sourceSessionId).toBe('S1')
    expect(mem.sourceEventIds).toEqual(['EVT-1', 'EVT-2'])
  })

  it('rejects invalid scope_type via CHECK constraint', () => {
    expect(() =>
      memories.create({
        scopeType: 'invalid' as never,
        scopeId: 'x',
        memoryType: 'episodic',
        content: 'bad scope'
      })
    ).toThrow()
  })

  it('rejects invalid memory_type via CHECK constraint', () => {
    expect(() =>
      memories.create({
        scopeType: 'project',
        scopeId: 'p1',
        memoryType: 'semantic' as never,
        content: 'bad type'
      })
    ).toThrow()
  })
})

describe('AgentMemoryRepository.recall', () => {
  it('returns [] when no memories match the scope', () => {
    memories.create({ scopeType: 'project', scopeId: 'p1', memoryType: 'episodic', content: 'x' })
    expect(memories.recall({ scopeType: 'project', scopeId: 'NONE' })).toEqual([])
  })

  it('returns memories for the matching scope', () => {
    memories.create({ scopeType: 'project', scopeId: 'p1', memoryType: 'episodic', content: 'A' })
    memories.create({ scopeType: 'project', scopeId: 'p1', memoryType: 'procedural', content: 'B' })
    memories.create({ scopeType: 'project', scopeId: 'p2', memoryType: 'episodic', content: 'C' })
    const result = memories.recall({ scopeType: 'project', scopeId: 'p1' })
    expect(result).toHaveLength(2)
    expect(result.map((m) => m.content).sort()).toEqual(['A', 'B'])
  })

  it('filters by memoryType when provided', () => {
    memories.create({ scopeType: 'project', scopeId: 'p1', memoryType: 'episodic', content: 'Ep' })
    memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'procedural',
      content: 'Proc'
    })
    const result = memories.recall({ scopeType: 'project', scopeId: 'p1', memoryType: 'episodic' })
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Ep')
  })

  it('ranks by importance DESC then recall_count DESC', () => {
    memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'low',
      importance: 20
    })
    memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'high',
      importance: 90
    })
    memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'mid',
      importance: 50
    })
    const result = memories.recall({ scopeType: 'project', scopeId: 'p1' })
    expect(result.map((m) => m.content)).toEqual(['high', 'mid', 'low'])
  })

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      memories.create({ scopeType: 'user', scopeId: 'u1', memoryType: 'episodic', content: `m${i}` })
    }
    const result = memories.recall({ scopeType: 'user', scopeId: 'u1', limit: 3 })
    expect(result).toHaveLength(3)
  })

  it('does not leak across scope_type', () => {
    memories.create({ scopeType: 'user', scopeId: 'u1', memoryType: 'episodic', content: 'user' })
    memories.create({
      scopeType: 'project',
      scopeId: 'u1',
      memoryType: 'episodic',
      content: 'project'
    })
    expect(memories.recall({ scopeType: 'user', scopeId: 'u1' })).toHaveLength(1)
  })

  it('handles corrupted tags JSON gracefully — returns []', () => {
    db.prepare(
      `INSERT INTO agent_memories
       (id, scope_type, scope_id, memory_type, content, tags, importance, recall_count)
       VALUES ('bad-tags', 'project', 'px', 'episodic', 'content', 'NOT_JSON', 50, 0)`
    ).run()
    const result = memories.recall({ scopeType: 'project', scopeId: 'px' })
    expect(result).toHaveLength(1)
    expect(result[0].tags).toEqual([])
  })
})

describe('AgentMemoryRepository.updateRecallStats', () => {
  it('increments recall_count and sets last_recalled_at', () => {
    const mem = memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'x'
    })
    expect(mem.recallCount).toBe(0)
    expect(mem.lastRecalledAt).toBeNull()

    memories.updateRecallStats(mem.id)
    const updated = memories.get(mem.id)!
    expect(updated.recallCount).toBe(1)
    expect(updated.lastRecalledAt).toBeTruthy()

    memories.updateRecallStats(mem.id)
    expect(memories.get(mem.id)!.recallCount).toBe(2)
  })
})

describe('AgentMemoryRepository.promoteMarkPromoted', () => {
  it('adds a promoted tag to the memory', () => {
    const mem = memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'important decision'
    })
    memories.promoteMarkPromoted(mem.id, 'adr-023')
    const updated = memories.get(mem.id)!
    expect(updated.tags).toContain('promoted:adr-023')
  })

  it('preserves existing tags when promoting', () => {
    const mem = memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'y',
      tags: ['foo', 'bar']
    })
    memories.promoteMarkPromoted(mem.id, 'adr-001')
    const updated = memories.get(mem.id)!
    expect(updated.tags).toEqual(['foo', 'bar', 'promoted:adr-001'])
  })

  it('is idempotent — does not duplicate the promoted tag', () => {
    const mem = memories.create({
      scopeType: 'project',
      scopeId: 'p1',
      memoryType: 'episodic',
      content: 'z'
    })
    memories.promoteMarkPromoted(mem.id, 'adr-005')
    memories.promoteMarkPromoted(mem.id, 'adr-005')
    const updated = memories.get(mem.id)!
    expect(updated.tags.filter((t) => t === 'promoted:adr-005')).toHaveLength(1)
  })

  it('is a no-op for a missing id', () => {
    expect(() => memories.promoteMarkPromoted('NO-SUCH', 'adr-x')).not.toThrow()
  })
})
