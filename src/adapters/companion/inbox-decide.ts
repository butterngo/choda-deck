import type { IncomingMessage, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { InboxItem } from '../../core/domain/task-types'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'
import type { InboxLifecycleOperations } from '../../core/domain/interfaces/inbox-lifecycle.interface'

// TASK-2380 — what automated sources filed and nobody has decided on yet, for
// the companion's "Cần anh quyết" screen (TASK-2381). Over three weeks the daily
// digest filed 15 ideas into a 417-item raw inbox and 13 were never seen
// (2026-10-11). So this lists ONLY tagged items from automated sources, puts the
// digest first, and lets each be converted or archived where it is read.
//
// Butter's own captures (untagged) stay out on purpose: they are the 400 items
// that would bury the six that need a decision.

const PREFIX = '/inbox/'
const MAX_BODY_BYTES = 64 * 1024
const ID = /^[A-Za-z0-9._-]+$/

export type PendingSource = 'activity-digest' | 'improve' | 'improve-note'

export interface PendingItem {
  id: string
  source: PendingSource
  workspaceId: string | null
  /** First line of the content, prefix removed. */
  title: string
  content: string
  createdAt: string
}

export interface InboxDecideDeps {
  svc: Pick<InboxOperations, 'findInbox' | 'getInbox'> & InboxLifecycleOperations
  bridgeToken: string
}

/** The source an item's tag names, or null for anything this screen must not show. */
export function pendingSource(content: string): { source: PendingSource; tag: string } | null {
  if (content.startsWith('[activity-digest]')) {
    return { source: 'activity-digest', tag: '[activity-digest]' }
  }
  const m = /^\[(improve|improve-note):([A-Za-z0-9._-]+)\]/.exec(content)
  if (!m) return null
  return { source: m[1] as PendingSource, tag: m[0] }
}

function toPending(item: InboxItem): PendingItem | null {
  const src = pendingSource(item.content)
  if (!src) return null
  const firstLine = item.content.slice(src.tag.length).trim().split(/\r?\n/)[0] ?? ''
  return {
    id: item.id,
    source: src.source,
    workspaceId: item.workspaceId,
    title: firstLine,
    content: item.content,
    createdAt: item.createdAt
  }
}

/** Digest first — Butter's requirement that it be the most visible thing — then newest first. */
export function orderPending(items: PendingItem[]): PendingItem[] {
  const rank = (s: PendingSource): number => (s === 'activity-digest' ? 0 : 1)
  return [...items].sort(
    (a, b) => rank(a.source) - rank(b.source) || b.createdAt.localeCompare(a.createdAt)
  )
}

/**
 * The convert template. inbox_convert refuses a body without the task headings;
 * `- [ ]` lines in the item become the Acceptance, and an item without any gets
 * a criterion that keeps the task out of READY until someone writes real ones.
 */
export function decideTaskBody(item: PendingItem): string {
  const acs = item.content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- [ ]'))
  return [
    '## Context',
    item.content.trim(),
    '',
    '## Acceptance',
    ...(acs.length
      ? acs
      : ['- [ ] Write falsifiable acceptance criteria for this change before moving it to READY']),
    '',
    '## Test Plan',
    'Defined with the acceptance criteria.',
    '',
    '## Related',
    `Converted from ${item.id} (${item.source}) on the companion's decide screen (TASK-2381).`,
    ''
  ].join('\n')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(c as Buffer)
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8')
    return text.trim() ? JSON.parse(text) : {}
  } catch {
    return null
  }
}

async function listPending(deps: InboxDecideDeps): Promise<PendingItem[]> {
  const raw = await deps.svc.findInbox({ status: 'raw' })
  return orderPending(raw.map(toPending).filter((p): p is PendingItem => p !== null))
}

/** Returns true when it handled the request. */
export async function handleInboxDecideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: InboxDecideDeps
): Promise<boolean> {
  const raw = (req.url ?? '/').split('?')[0]
  const isPending = raw === '/inbox/pending'
  const action = /^\/inbox\/([^/]+)\/(convert|archive)$/.exec(raw)
  if (!isPending && !action) return false
  if (!raw.startsWith(PREFIX)) return false

  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, deps.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  try {
    if (isPending) {
      if (req.method !== 'GET') return (sendJson(res, 405, { error: 'GET only' }), true)
      sendJson(res, 200, { items: await listPending(deps) })
      return true
    }

    if (req.method !== 'POST') return (sendJson(res, 405, { error: 'POST only' }), true)
    const [, id, verb] = action as RegExpExecArray
    if (!ID.test(id)) return (sendJson(res, 400, { error: 'invalid inbox id' }), true)
    const item = await deps.svc.getInbox(id)
    const pending = item ? toPending(item) : null
    if (!item || !pending) {
      sendJson(res, 404, { error: `no pending automated inbox item ${id}` })
      return true
    }
    if (item.status !== 'raw') {
      sendJson(res, 409, { error: `${id} is already ${item.status}` })
      return true
    }

    if (verb === 'convert') {
      const result = await deps.svc.convertInboxToTask(id, {
        title: pending.title.slice(0, 200) || `Inbox ${id}`,
        labels: [pending.source === 'activity-digest' ? 'activity-digest' : 'improve-loop'],
        body: decideTaskBody(pending)
      })
      sendJson(res, 200, { inboxId: id, taskId: result.taskId })
      return true
    }

    const body = (await readJson(req)) as { reason?: unknown } | null
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (!reason) {
      sendJson(res, 400, { error: 'reason is required', field: 'reason' })
      return true
    }
    await deps.svc.archiveInbox(id, reason)
    sendJson(res, 200, { inboxId: id, archived: true })
    return true
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message })
    return true
  }
}
