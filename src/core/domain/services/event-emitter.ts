import * as fs from 'fs'
import * as path from 'path'
import { resolveEventDir } from '../../paths'

export type ConversationEventType =
  | 'message.question'
  | 'message.answer'
  | 'conversation.open'
  | 'conversation.close'
  | 'conversation.reopen'
  | 'conversation.decide'

export interface ConversationEvent {
  type: ConversationEventType
  conversationId: string
  roles: string[]
  messageType: string
  author: string
  timestamp: string
}

// SQLite `datetime('now')` returns UTC in `YYYY-MM-DD HH:MM:SS` form (no T, no Z).
// Coerce to ISO so the JSONL contract is uniform across message + lifecycle paths.
export function normalizeEventTimestamp(timestamp: string): string {
  if (timestamp.includes('T')) return timestamp
  return new Date(timestamp.replace(' ', 'T') + 'Z').toISOString()
}

/**
 * Append a conversation event as one JSONL line to <eventDir>/<projectId>.jsonl.
 *
 * Fire-and-forget: auto-creates the directory; on any I/O error, logs a warning
 * and swallows — must never block the caller (DB message insert must succeed
 * even when the event dir is unwritable).
 */
export function emitConversationEvent(projectId: string, event: ConversationEvent): void {
  try {
    const dir = resolveEventDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${projectId}.jsonl`)
    const normalized: ConversationEvent = {
      ...event,
      timestamp: normalizeEventTimestamp(event.timestamp)
    }
    fs.appendFileSync(file, JSON.stringify(normalized) + '\n')
  } catch (err) {
    console.warn('[conversation-event-emitter] emit failed:', err)
  }
}

/**
 * Fan-out emit for cross-project routing (ADR-021 Phase 3).
 *
 * Owner project's file is always written first (preserves Phase 1/2 behavior).
 * Each unique target projectId not equal to the owner gets the same JSONL line
 * appended to its own <projectId>.jsonl. Targets must already be validated by
 * the caller — the emitter does not query the DB.
 *
 * Best-effort: each write is independently swallowed via emitConversationEvent's
 * own try/catch, so a failure on one target never blocks the others or the owner.
 */
export function emitConversationEventFanout(
  ownerProjectId: string,
  targetProjectIds: readonly string[],
  event: ConversationEvent
): void {
  emitConversationEvent(ownerProjectId, event)
  const seen = new Set<string>([ownerProjectId])
  for (const target of targetProjectIds) {
    if (seen.has(target)) continue
    seen.add(target)
    emitConversationEvent(target, event)
  }
}
