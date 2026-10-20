// TASK-2549 — sign off on a conversation from the companion, as one named
// participant.
//
// A decide (conversation-decide.ts, TASK-2541) records the decision, but a
// thread folds to `decided` only once every participant has signed off. This
// is the route that lets the companion add its owner's signoff, so a thread can
// actually be closed from the app.
//
// It signs for exactly the name in the request, and only when that name is a
// participant of the thread. The domain's signoffConversation does not check
// participation, so this route does: a signoff from a stranger would count
// toward nobody's consensus and still read as a signature in the thread.
// Participants are read the way GET /conversations/:id reads them, so the
// route refuses exactly the names the companion does not show.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const MAX_BODY_BYTES = 64 * 1024
const SIGNOFF_PATH = /^\/conversations\/([^/]+)\/signoff$/

export interface ConversationSignoffOptions {
  bridgeToken: string
  svc: Pick<BackendTaskService, 'getConversation' | 'getConversationParticipants' | 'signoffConversation'>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Returns true when it handled the request. */
export async function handleConversationSignoffRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ConversationSignoffOptions
): Promise<boolean> {
  const match = (req.url ?? '').split('?')[0]?.match(SIGNOFF_PATH)
  if (!match) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return true
  }
  let parsed: { name?: unknown }
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof parsed)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }
  if (typeof parsed.name !== 'string' || parsed.name.trim() === '') {
    sendJson(res, 400, { error: 'name is required' })
    return true
  }
  const name = parsed.name.trim()

  const id = decodeURIComponent(match[1] ?? '')
  if (!(await opts.svc.getConversation(id))) {
    sendJson(res, 404, { error: `unknown conversation: ${id}` })
    return true
  }
  const participants = await opts.svc.getConversationParticipants(id)
  if (!participants.some((p) => p.name === name)) {
    sendJson(res, 400, { error: `not a participant: ${name}` })
    return true
  }

  const { conversation, signedOff, decided } = await opts.svc.signoffConversation(id, name)
  sendJson(res, 200, { conversation, signedOff, decided })
  return true
}
