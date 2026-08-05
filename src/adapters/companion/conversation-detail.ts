// TASK-1568 — conversation detail read for the companion. The bridge served only
// the list (`GET /conversations`); without a detail route the web app cannot show
// a thread at all — and conversation is where image / network / design / element
// captures land, since they may never target inbox or task (gotcha
// `secret-carrying-capture-kinds-are-local-only-never-inbox-task`).
//
// Read-only, GET-only, no repository work: every method already exists on
// ConversationOperations. Domain objects are passed through unchanged, the same
// contract as handleTaskDetailRoute / handleKnowledgeRoute — no bespoke field
// renaming for one route.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * GET /conversations/:id → { conversation, messages, participants }.
 *
 * Returns false for anything else — including bare `/conversations`, which stays
 * on http-server's exact-match switch, and non-GET methods, which fall through to
 * the shared 405 guard.
 */
export async function handleConversationDetailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/conversations\/([^/]+)$/)
  if (!match) return false
  if ((req.method ?? 'GET') !== 'GET') return false

  const id = decodeURIComponent(match[1])
  const conversation = await svc.getConversation(id)
  if (!conversation) {
    sendJson(res, 404, { error: `unknown conversation: ${id}` })
    return true
  }
  // getConversationMessages returns append-order (oldest first) — the order a
  // thread reads in. Not re-sorted here: createdAt is second-resolution, so
  // sorting on it would scramble same-second turns.
  const [messages, participants] = await Promise.all([
    svc.getConversationMessages(id),
    svc.getConversationParticipants(id)
  ])
  sendJson(res, 200, { conversation, messages, participants })
  return true
}
