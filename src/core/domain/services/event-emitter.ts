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
    fs.appendFileSync(file, JSON.stringify(event) + '\n')
  } catch (err) {
    console.warn('[conversation-event-emitter] emit failed:', err)
  }
}
