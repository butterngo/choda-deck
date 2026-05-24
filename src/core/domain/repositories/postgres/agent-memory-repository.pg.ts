// ADR-030 — Postgres sibling of AgentMemoryRepository.
// tags + source_event_ids are JSONB (node-pg auto-parses the string[] back —
// no SQLite-side parseTags helper needed). recall() filters by tags client-side
// to match SQLite behavior exactly; the DB-side jsonb ?| approach exists but
// post-filter keeps semantics identical and lets us page-then-filter cleanly.

import type { Queryable, SqlValue } from './connection'
import type {
  AgentMemory,
  CreateAgentMemoryInput,
  MemoryRecallQuery,
  MemoryScopeType,
  MemoryType
} from '../../task-types'
import { generateId, now } from '../shared'

interface AgentMemoryDbRow {
  id: string
  scope_type: string
  scope_id: string
  memory_type: string
  content: string
  tags: string[] | null
  importance: number
  source_session_id: string | null
  source_event_ids: string[] | null
  created_at: string
  last_recalled_at: string | null
  recall_count: number
}

function mapRow(row: AgentMemoryDbRow): AgentMemory {
  return {
    id: row.id,
    scopeType: row.scope_type as MemoryScopeType,
    scopeId: row.scope_id,
    memoryType: row.memory_type as MemoryType,
    content: row.content,
    tags: row.tags ?? [],
    importance: row.importance,
    sourceSessionId: row.source_session_id,
    sourceEventIds: row.source_event_ids ?? [],
    createdAt: row.created_at,
    lastRecalledAt: row.last_recalled_at,
    recallCount: row.recall_count
  }
}

const SELECT_COLS =
  'id, scope_type, scope_id, memory_type, content, tags, importance, source_session_id, source_event_ids, created_at, last_recalled_at, recall_count'

export class PostgresAgentMemoryRepository {
  constructor(private readonly conn: Queryable) {}

  async create(input: CreateAgentMemoryInput): Promise<AgentMemory> {
    const id = input.id || generateId('MEM')
    const ts = now()
    await this.conn.query(
      `INSERT INTO agent_memories
         (id, scope_type, scope_id, memory_type, content, tags, importance,
          source_session_id, source_event_ids, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10)`,
      [
        id,
        input.scopeType,
        input.scopeId,
        input.memoryType,
        input.content,
        input.tags ? JSON.stringify(input.tags) : null,
        input.importance ?? 50,
        input.sourceSessionId || null,
        input.sourceEventIds ? JSON.stringify(input.sourceEventIds) : null,
        ts
      ]
    )
    const got = await this.get(id)
    if (!got) throw new Error(`AgentMemory disappeared after insert: ${id}`)
    return got
  }

  async get(id: string): Promise<AgentMemory | null> {
    const result = await this.conn.query<AgentMemoryDbRow>(
      `SELECT ${SELECT_COLS} FROM agent_memories WHERE id = $1`,
      [id]
    )
    const row = result.rows[0]
    return row ? mapRow(row) : null
  }

  async recall(query: MemoryRecallQuery): Promise<AgentMemory[]> {
    const conditions: string[] = ['scope_type = $1', 'scope_id = $2']
    const params: SqlValue[] = [query.scopeType, query.scopeId]
    let n = 3

    if (query.memoryType) {
      conditions.push(`memory_type = $${n++}`)
      params.push(query.memoryType)
    }

    let sql = `SELECT ${SELECT_COLS} FROM agent_memories
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance DESC, recall_count DESC, created_at DESC`
    if (query.limit !== undefined) {
      sql += ` LIMIT $${n++}`
      params.push(query.limit)
    }

    const result = await this.conn.query<AgentMemoryDbRow>(sql, params)
    let memories = result.rows.map(mapRow)

    if (query.tags && query.tags.length > 0) {
      const tagSet = new Set(query.tags)
      memories = memories.filter((m) => m.tags.some((t) => tagSet.has(t)))
    }

    return memories
  }

  async updateRecallStats(id: string): Promise<void> {
    const ts = now()
    await this.conn.query(
      `UPDATE agent_memories
       SET recall_count = recall_count + 1, last_recalled_at = $1
       WHERE id = $2`,
      [ts, id]
    )
  }

  async promoteMarkPromoted(id: string, adrSlug: string): Promise<void> {
    const row = await this.conn.query<{ tags: string[] | null }>(
      'SELECT tags FROM agent_memories WHERE id = $1',
      [id]
    )
    if (row.rows.length === 0) return
    const tags = row.rows[0].tags ?? []
    const marker = `promoted:${adrSlug}`
    if (!tags.includes(marker)) {
      tags.push(marker)
      await this.conn.query(
        'UPDATE agent_memories SET tags = $1::jsonb WHERE id = $2',
        [JSON.stringify(tags), id]
      )
    }
  }
}
