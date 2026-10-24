// TASK-2733 — the chat assistant's history, on this machine only.
//
// The two tables are created by initSchema (schema.ts, createAssistantTables)
// and are NOT in the sync allowlist: a chat carries text the assistant read from
// the vault. This store is the only code that writes them, through its own
// writable connection — the companion's shared `db` handle is read-only.

import type Database from 'better-sqlite3'

export const DEFAULT_TOKEN_BUDGET = 300_000
export const MIN_TOKEN_BUDGET = 200_000
export const MAX_TOKEN_BUDGET = 400_000

export interface AssistantChat {
  id: string
  title: string
  model: string | null
  tokensUsed: number
  tokenBudget: number
  createdAt: string
  updatedAt: string
}

export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  toolName: string | null
  toolCallId: string | null
  model: string | null
  promptTokens: number | null
  completionTokens: number | null
  tokensEstimated: boolean
  createdAt: string
}

export interface NewAssistantMessage {
  role: AssistantMessage['role']
  content: string | null
  toolName?: string | null
  toolCallId?: string | null
  model?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  tokensEstimated?: boolean
}

interface ChatRow {
  id: string
  title: string
  model: string | null
  token_budget: number
  tokens_used: number
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  role: AssistantMessage['role']
  content: string | null
  tool_name: string | null
  tool_call_id: string | null
  model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  tokens_estimated: number
  created_at: string
}

function toChat(r: ChatRow): AssistantChat {
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

function toMessage(r: MessageRow): AssistantMessage {
  return {
    id: r.id,
    role: r.role,
    content: r.content,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    model: r.model,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    tokensEstimated: r.tokens_estimated === 1,
    createdAt: r.created_at
  }
}

export class AssistantStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  listChats(): AssistantChat[] {
    const rows = this.db
      .prepare('SELECT * FROM assistant_chats ORDER BY updated_at DESC, id DESC')
      .all() as ChatRow[]
    return rows.map(toChat)
  }

  getChat(id: string): AssistantChat | null {
    const row = this.db.prepare('SELECT * FROM assistant_chats WHERE id = ?').get(id) as
      | ChatRow
      | undefined
    return row ? toChat(row) : null
  }

  createChat(input: { title?: string; model?: string | null; tokenBudget?: number }): AssistantChat {
    const at = this.now()
    const next = this.db
      .prepare(
        "SELECT COALESCE(MAX(CAST(substr(id, 6) AS INTEGER)), 0) + 1 AS n FROM assistant_chats WHERE id LIKE 'CHAT-%'"
      )
      .get() as { n: number }
    const id = `CHAT-${next.n}`
    this.db
      .prepare(
        'INSERT INTO assistant_chats (id, title, model, token_budget, tokens_used, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
      )
      .run(
        id,
        input.title?.trim() || 'New chat',
        input.model ?? null,
        input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
        at,
        at
      )
    return this.getChat(id) as AssistantChat
  }

  listMessages(chatId: string): AssistantMessage[] {
    const rows = this.db
      .prepare('SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(chatId) as MessageRow[]
    return rows.map(toMessage)
  }

  appendMessage(chatId: string, msg: NewAssistantMessage): AssistantMessage {
    const at = this.now()
    const seq = this.db
      .prepare('SELECT COUNT(*) + 1 AS n FROM assistant_messages WHERE chat_id = ?')
      .get(chatId) as { n: number }
    const id = `${chatId}-M${seq.n}`
    this.db
      .prepare(
        `INSERT INTO assistant_messages
           (id, chat_id, role, content, tool_name, tool_call_id, model, prompt_tokens, completion_tokens, tokens_estimated, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        chatId,
        msg.role,
        msg.content,
        msg.toolName ?? null,
        msg.toolCallId ?? null,
        msg.model ?? null,
        msg.promptTokens ?? null,
        msg.completionTokens ?? null,
        msg.tokensEstimated ? 1 : 0,
        at
      )
    this.db.prepare('UPDATE assistant_chats SET updated_at = ? WHERE id = ?').run(at, chatId)
    const row = this.db.prepare('SELECT * FROM assistant_messages WHERE id = ?').get(id) as MessageRow
    return toMessage(row)
  }

  addTokens(chatId: string, tokens: number): AssistantChat | null {
    this.db
      .prepare('UPDATE assistant_chats SET tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?')
      .run(tokens, this.now(), chatId)
    return this.getChat(chatId)
  }
}
