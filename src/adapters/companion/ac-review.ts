// TASK-1860 — grade a task's acceptance criteria against a stated standard.
//
// READY is the gate that lets /choda-burn-backlog implement, PR and merge
// unattended. A criterion that cannot fail passing through that gate means the
// runner grades its own homework, which is the failure the whole system exists
// to prevent.
//
// /choda-plan §3d already writes the standard down in five tests. Nothing
// applies it except a human remembering to. That is the gap this route closes,
// and it is the judgement a schema genuinely cannot make: prose measured
// against a stated standard.
//
// The cost boundary from TASK-1843 holds unchanged — its own route, reached only
// on an explicit request. /tasks stays free.
//
// TASK-1914 — the grading itself now lives in ac-grader.ts, because the
// `ac_review` MCP tool grades by the same standard and a second copy of the five
// tests would be a second standard. What remains here is this route's dialect:
// which HTTP status each outcome deserves.

import type { IncomingMessage, ServerResponse } from 'http'
import { gradeAcceptance, type AcVerdict } from './ac-grader'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

export type { AcVerdict } from './ac-grader'
export { parseAcceptance } from './ac-grader'

const AC_REVIEW_ROUTE = '/tasks/ac-review'
const MAX_BODY_BYTES = 64 * 1024

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

export interface AcReviewOptions {
  bridgeToken: string
  svc: BackendTaskService
  dataDir?: string
  fetchImpl?: typeof fetch
}

export async function handleAcReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AcReviewOptions
): Promise<boolean> {
  const rawPath = (req.url ?? '').split('?')[0] ?? ''
  if (rawPath !== AC_REVIEW_ROUTE) return false

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
  let parsed: { taskId?: unknown; model?: unknown }
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof parsed)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }
  if (typeof parsed.taskId !== 'string' || parsed.taskId === '') {
    sendJson(res, 400, { error: 'taskId is required' })
    return true
  }

  const task = await opts.svc.getTask(parsed.taskId)
  if (task === null) {
    sendJson(res, 404, { error: `unknown task: ${parsed.taskId}` })
    return true
  }

  const result = await gradeAcceptance({
    body: task.body ?? '',
    dataDir: opts.dataDir,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    fetchImpl: opts.fetchImpl
  })

  // One outcome, one status. The mapping is this route's own — the same result
  // reaches the MCP tool and is said differently there.
  if (result.kind === 'no-criteria') {
    sendJson(res, 404, { error: 'no acceptance criteria' })
    return true
  }
  if (result.kind === 'no-provider') {
    sendJson(res, 501, { error: 'no model configured' })
    return true
  }
  if (result.kind === 'failed') {
    if (result.errorKind === 'no_key') {
      sendJson(res, 501, { error: 'no model configured' })
    } else if (result.errorKind === 'rate_limit') {
      if (result.retryAfter) res.setHeader('retry-after', result.retryAfter)
      sendJson(res, 429, { error: 'rate limited', kind: result.errorKind })
    } else {
      // The adapter's own message. A provider body can echo the key back in a
      // reflected request, and forwarding it verbatim is how a secret reaches a
      // log nobody thought was sensitive.
      sendJson(res, 502, { error: 'provider failed', kind: result.errorKind })
    }
    return true
  }

  const out: AcVerdict[] = result.criteria
  sendJson(res, 200, { criteria: out })
  return true
}
