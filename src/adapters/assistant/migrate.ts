// TASK-2755 — the one-time copy of the adapter-era chats into assistant.db.
//
// Before the service existed, chats lived in the shared choda-deck.db
// (assistant_chats / assistant_messages, TASK-2733). On start, while
// assistant.db holds no chat, every one of them is copied with its ids,
// timestamps and token totals. The shared database is opened read-only and is
// never changed: its tables are the source on any machine that has not started
// this version yet, and deleting user data is not reversible.

import * as fs from 'fs'
import Database from 'better-sqlite3'
import type { ChatMessage, ChatStore } from './chat-store'

interface OldChat {
  id: string
  title: string
  model: string | null
  token_budget: number
  tokens_used: number
  created_at: string
  updated_at: string
}

interface OldMessage {
  id: string
  role: ChatMessage['role']
  content: string | null
  tool_name: string | null
  tool_call_id: string | null
  model: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  tokens_estimated: number
  created_at: string
}

/** The k of an old `<chat>-M<k>` id, else its position. */
function seqOf(id: string, position: number): number {
  const m = /-M(\d+)$/.exec(id)
  return m ? Number.parseInt(m[1], 10) : position
}

/**
 * Copies the shared database's chats into `store` when the store has none.
 * Returns the number of chats copied; 0 when the store already had chats, the
 * file is missing, or it has no assistant tables.
 */
export function migrateSharedChats(store: ChatStore, sharedDbPath: string): number {
  if (store.countChats() > 0) return 0
  if (!fs.existsSync(sharedDbPath)) return 0

  const shared = new Database(sharedDbPath, { readonly: true, fileMustExist: true })
  try {
    const hasTable = shared
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'assistant_chats'")
      .get()
    if (!hasTable) return 0

    const chats = shared.prepare('SELECT * FROM assistant_chats ORDER BY created_at ASC, id ASC').all() as OldChat[]
    const messagesOf = shared.prepare(
      'SELECT * FROM assistant_messages WHERE chat_id = ? ORDER BY created_at ASC, rowid ASC'
    )
    for (const c of chats) {
      const rows = messagesOf.all(c.id) as OldMessage[]
      store.importChat({
        id: c.id,
        title: c.title,
        model: c.model,
        tokenBudget: c.token_budget,
        tokensUsed: c.tokens_used,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        messages: rows.map((m, i) => ({
          id: m.id,
          seq: seqOf(m.id, i + 1),
          role: m.role,
          content: m.content,
          toolName: m.tool_name,
          toolCallId: m.tool_call_id,
          model: m.model,
          promptTokens: m.prompt_tokens,
          completionTokens: m.completion_tokens,
          tokensEstimated: m.tokens_estimated === 1,
          createdAt: m.created_at
        }))
      })
    }
    return chats.length
  } finally {
    shared.close()
  }
}
