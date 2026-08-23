// TASK-1444 follow-up — task-detail read for the graph. GET /tasks/:id returns
// the full task (body / acceptance criteria / status / blockers) so clicking a
// task node in the companion graph can show its detail, the way /knowledge/:slug
// already does for knowledge nodes. Read-only, localhost-only, same contract as
// the other companion read routes. (POST /tasks/:id/ready lives in workflow.ts;
// this is GET-only and doesn't collide.)

// TASK-1748 extends the payload with provenance — which ADR decided this task,
// which files it changed, at which commit — so the companion can answer the
// three questions that currently require `git log --grep=TASK-xxx` and
// remembering which repo to run it in. See task-provenance.ts.

import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { buildTaskProvenance, type ProvenanceDeps } from './task-provenance'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same constant-time compare as the artifacts and vault gates, duplicated
// rather than exported so this module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

export async function handleTaskDetailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  svc: BackendTaskService,
  bridgeToken: string
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/tasks\/([^/]+)$/)
  if ((req.method ?? 'GET') !== 'GET' || !match) return false

  // TASK-1748 AC-9 — token-gated like /vault/notes. The payload now names
  // filesystem paths and commit shas, which is repo-shaped information the
  // ungated read never carried.
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const id = decodeURIComponent(match[1])
  const task = await svc.getTask(id)
  if (!task) {
    sendJson(res, 404, { error: `unknown task: ${id}` })
    return true
  }
  // Provenance is additive — the existing graph drawer reads the task fields and
  // is unaffected by the extra keys.
  const provenance = await buildTaskProvenance(
    svc as unknown as ProvenanceDeps,
    task.projectId,
    task.id
  )
  sendJson(res, 200, { ...task, ...provenance })
  return true
}
