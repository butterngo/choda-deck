// TASK-2755 — the assistant service's own chat history, in <dataDir>/assistant.db.
//
// A file of its own, never the shared choda-deck.db and never synced (ADR
// adr-when-this-project-may-call-a-model, 2026-10-26 amendment). This store is
// the only code that opens it.
//
// Ids never repeat. Chats take CHAT-<n> from a counter that only grows, and
// each chat hands out message seqs from its own `next_seq`, so deleting the
// tail of a chat (regenerate, edit-and-resend) or a whole chat cannot make a
// new row reuse an old id. The adapter's store derived both from COUNT/MAX,
// which reuses them (companion assistant-store.ts:150-153).

import type Database from 'better-sqlite3'

export const DEFAULT_TOKEN_BUDGET = 300_000
export const MIN_TOKEN_BUDGET = 200_000
export const MAX_TOKEN_BUDGET = 400_000

export interface ChatSummary {
  id: string
  title: string
  model: string | null
  tokensUsed: number
  tokenBudget: number
  createdAt: string
  updatedAt: string
}

export interface ChatMessage {
  id: string
  seq: number
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolName: string | null
  toolCallId: string | null
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  tokensEstimated: boolean
  interrupted: boolean
  createdAt: string
}

export interface NewChatMessage {
  role: ChatMessage['role']
  content: string | null
  toolName?: string | null
  toolCallId?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  tokensEstimated?: boolean
  interrupted?: boolean
}

/** A row as copied from elsewhere, id and timestamps kept. */
export interface ImportedChat extends ChatSummary {
  messages: (NewChatMessage & { id: string; seq: number; createdAt: string })[]
}

interface ChatRow {
  id: string
  title: string
  model: string | null
  token_budget: number
  tokens_used: number
  next_seq: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  seq: number
  role: ChatMessage['role']
  content: string | null
  tool_name: string | null
  tool_call_id: string | null
  model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  tokens_estimated: number
  interrupted: number
  created_at: string
}

export function createChatTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model TEXT,
      token_budget INTEGER NOT NULL DEFAULT 300000,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      next_seq INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
      content TEXT,
      tool_name TEXT,
      tool_call_id TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      tokens_estimated INTEGER NOT NULL DEFAULT 0,
      interrupted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
  `)
}

function toChat(r: ChatRow): ChatSummary {
  return {
    id: r.id,
    title: r.title,
    model: r.model,
    tokensUsed: r.tokens_used,
    tokenBudget: r.token_budget,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function toMessage(r: MessageRow): ChatMessage {
  return {
    id: r.id,
    seq: r.seq,
    role: r.role,
    content: r.content,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    model: r.model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    tokensEstimated: r.tokens_estimated === 1,
    interrupted: r.interrupted === 1,
    createdAt: r.created_at
  }
}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

export class ChatStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    createChatTables(db)
  }

  countChats(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n
  }

  /** Newest first. `query` keeps chats whose title or a user/assistant message holds every word. */
  listChats(query?: string): ChatSummary[] {
    const rows = this.db.prepare('SELECT * FROM chats ORDER BY updated_at DESC, id DESC').all() as ChatRow[]
    const q = query ? words(query) : []
    if (q.length === 0) return rows.map(toChat)
    const text = this.db.prepare(
      "SELECT lower(group_concat(content, ' ')) AS t FROM messages WHERE chat_id = ? AND role IN ('user','assistant') AND content IS NOT NULL"
    )
    return rows
      .filter((r) => {
        const hay = `${r.title.toLowerCase()} ${(text.get(r.id) as { t: string | null }).t ?? ''}`
        return q.every((w) => hay.includes(w))
      })
      .map(toChat)
  }

  getChat(id: string): ChatSummary | null {
    const row = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined
    return row ? toChat(row) : null
  }

  private nextChatNumber(): number {
    const row = this.db.prepare("SELECT value FROM counters WHERE name = 'chat'").get() as
      | { value: number }
      | undefined
    const next = (row?.value ?? 0) + 1
    this.db
      .prepare("INSERT INTO counters (name, value) VALUES ('chat', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
      .run(next)
    return next
  }

  createChat(input: { title?: string; model?: string | null; tokenBudget?: number }): ChatSummary {
    const at = this.now()
    const id = `CHAT-${this.db.transaction(() => this.nextChatNumber())()}`
    this.db
      .prepare(
        'INSERT INTO chats (id, title, model, token_budget, tokens_used, next_seq, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 1, ?, ?)'
      )
      .run(id, input.title?.trim() || 'New chat', input.model ?? null, input.tokenBudget ?? DEFAULT_TOKEN_BUDGET, at, at)
    return this.getChat(id) as ChatSummary
  }

  renameChat(id: string, title: string): ChatSummary | null {
    const r = this.db.prepare('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?').run(title, this.now(), id)
    return r.changes === 0 ? null : this.getChat(id)
  }

  /** Removes the chat and all its messages. False when there was no such chat. */
  deleteChat(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE chat_id = ?').run(id)
      return this.db.prepare('DELETE FROM chats WHERE id = ?').run(id).changes > 0
    })()
  }

  listMessages(chatId: string): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC')
      .all(chatId) as MessageRow[]
    return rows.map(toMessage)
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  appendMessage(chatId: string, msg: NewChatMessage): ChatMessage {
    const id = this.db.transaction(() => {
      const chat = this.db.prepare('SELECT next_seq FROM chats WHERE id = ?').get(chatId) as
        | { next_seq: number }
        | undefined
      if (!chat) throw new Error(`unknown chat: ${chatId}`)
      const seq = chat.next_seq
      const at = this.now()
      const rowId = `${chatId}-M${seq}`
      this.db
        .prepare(
          `INSERT INTO messages
             (id, chat_id, seq, role, content, tool_name, tool_call_id, model, prompt_tokens, completion_tokens, tokens_estimated, interrupted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          rowId,
          chatId,
          seq,
          msg.role,
          msg.content,
          msg.toolName ?? null,
          msg.toolCallId ?? null,
          msg.model ?? null,
          msg.promptTokens ?? null,
          msg.completionTokens ?? null,
          msg.tokensEstimated ? 1 : 0,
          msg.interrupted ? 1 : 0,
          at
        )
      this.db.prepare('UPDATE chats SET next_seq = ?, updated_at = ? WHERE id = ?').run(seq + 1, at, chatId)
      return rowId
    })()
    return this.getMessage(id) as ChatMessage
  }

  updateMessageContent(id: string, content: string): void {
    this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id)
  }

  /** Deletes every message of the chat whose seq is greater than `afterSeq`. Returns how many went. */
  deleteMessagesAfter(chatId: string, afterSeq: number): number {
    return this.db.prepare('DELETE FROM messages WHERE chat_id = ? AND seq > ?').run(chatId, afterSeq).changes
  }

  addTokens(chatId: string, tokens: number): ChatSummary | null {
    this.db
      .prepare('UPDATE chats SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?')
      .run(tokens, this.now(), chatId)
    return this.getChat(chatId)
  }

  /** Chats whose user or assistant messages contain every word, newest first (the search_chats tool). */
  searchChats(query: string, limit: number): { id: string; title: string; updatedAt: string; match: string }[] {
    const q = words(query)
    if (q.length === 0) return []
    const where = q.map(() => 'instr(lower(m.content), ?) > 0').join(' AND ')
    const rows = this.db
      .prepare(
        `SELECT c.id, c.title, c.updated_at, m.content
           FROM messages m JOIN chats c ON c.id = m.chat_id
          WHERE m.role IN ('user','assistant') AND m.content IS NOT NULL AND ${where}
          ORDER BY c.updated_at DESC`
      )
      .all(...q) as { id: string; title: string; updated_at: string; content: string }[]
    const out: { id: string; title: string; updatedAt: string; match: string }[] = []
    for (const r of rows) {
      if (out.some((o) => o.id === r.id)) continue
      out.push({ id: r.id, title: r.title, updatedAt: r.updated_at, match: r.content.slice(0, 200) })
      if (out.length >= limit) break
    }
    return out
  }

  /** Copies a chat from elsewhere with its ids and timestamps. Used once, by the migration. */
  importChat(chat: ImportedChat): void {
    this.db.transaction(() => {
      const nextSeq = chat.messages.reduce((m, x) => Math.max(m, x.seq), 0) + 1
      this.db
        .prepare(
          'INSERT INTO chats (id, title, model, token_budget, tokens_used, next_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(chat.id, chat.title, chat.model, chat.tokenBudget, chat.tokensUsed, nextSeq, chat.createdAt, chat.updatedAt)
      const insert = this.db.prepare(
        `INSERT INTO messages
           (id, chat_id, seq, role, content, tool_name, tool_call_id, model, prompt_tokens, completion_tokens, tokens_estimated, interrupted, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const m of chat.messages) {
        insert.run(
          m.id,
          chat.id,
          m.seq,
          m.role,
          m.content,
          m.toolName ?? null,
          m.toolCallId ?? null,
          m.model ?? null,
          m.promptTokens ?? null,
          m.completionTokens ?? null,
          m.tokensEstimated ? 1 : 0,
          m.interrupted ? 1 : 0,
          m.createdAt
        )
      }
      const n = Number.parseInt(chat.id.replace(/^CHAT-/, ''), 10)
      if (Number.isInteger(n)) {
        this.db
          .prepare(
            "INSERT INTO counters (name, value) VALUES ('chat', ?) ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)"
          )
          .run(n)
      }
    })()
  }
}
