import type Database from 'better-sqlite3'
import type {
  AgentMemory,
  MemoryScopeType,
  MemoryType,
  CreateAgentMemoryInput,
  MemoryRecallQuery
} from '../task-types'
import { now, generateId } from './shared'

function parseTags(raw: unknown): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw as string)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function parseEventIds(raw: unknown): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw as string)
    return Array.isArray(parsed) ? (parsed as string[]) : []
  } catch {
    return []
  }
}

function rowToAgentMemory(row: Record<string, unknown>): AgentMemory {
  return {
    id: row.id as string,
    scopeType: row.scope_type as MemoryScopeType,
    scopeId: row.scope_id as string,
    memoryType: row.memory_type as MemoryType,
    content: row.content as string,
    tags: parseTags(row.tags),
    importance: row.importance as number,
    sourceSessionId: (row.source_session_id as string) || null,
    sourceEventIds: parseEventIds(row.source_event_ids),
    createdAt: row.created_at as string,
    lastRecalledAt: (row.last_recalled_at as string) || null,
    recallCount: row.recall_count as number
  }
}

export class AgentMemoryRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateAgentMemoryInput): AgentMemory {
    const id = input.id || generateId('MEM')
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO agent_memories
         (id, scope_type, scope_id, memory_type, content, tags, importance, source_session_id, source_event_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
      )
    return this.get(id)!
  }

  get(id: string): AgentMemory | null {
    const row = this.db.prepare('SELECT * FROM agent_memories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToAgentMemory(row) : null
  }

  recall(query: MemoryRecallQuery): AgentMemory[] {
    const conditions: string[] = ['scope_type = ?', 'scope_id = ?']
    const params: (string | number)[] = [query.scopeType, query.scopeId]

    if (query.memoryType) {
      conditions.push('memory_type = ?')
      params.push(query.memoryType)
    }

    let sql = `SELECT * FROM agent_memories WHERE ${conditions.join(' AND ')} ORDER BY importance DESC, recall_count DESC, created_at DESC`
    if (query.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(query.limit)
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    let memories = rows.map(rowToAgentMemory)

    if (query.tags && query.tags.length > 0) {
      const tagSet = new Set(query.tags)
      memories = memories.filter((m) => m.tags.some((t) => tagSet.has(t)))
    }

    return memories
  }

  updateRecallStats(id: string): void {
    const ts = now()
    this.db
      .prepare(
        `UPDATE agent_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?`
      )
      .run(ts, id)
  }

  promoteMarkPromoted(id: string, adrSlug: string): void {
    const row = this.db
      .prepare('SELECT tags FROM agent_memories WHERE id = ?')
      .get(id) as { tags: string | null } | undefined
    if (!row) return
    const tags = parseTags(row.tags)
    const marker = `promoted:${adrSlug}`
    if (!tags.includes(marker)) {
      tags.push(marker)
      this.db
        .prepare('UPDATE agent_memories SET tags = ? WHERE id = ?')
        .run(JSON.stringify(tags), id)
    }
  }
}
