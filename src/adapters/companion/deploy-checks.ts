// TASK-2605 — tick a run's deploy checklist from the companion, per environment.
// Butter, 2026-10-21: ticks live in the choda DB per environment, shared with
// /ichiba-deploy (which writes through MCP, TASK-2606), and sync.
//
//   GET  /runs/<goal>/deploy-checks  → { qc: { [itemKey]: { doneBy, doneAt, note } }, prod: {…} }
//   POST /runs/<goal>/deploy-checks  { env, itemKey, done, note? } → the same shape
//
// Writes go through the writable service the server hands every route
// (gotcha companion-mutations-only-writable-svc-only-workflow-routes), which on a
// sync laptop is the write-through proxy, so a tick is pushed like an inbox item.

import type { IncomingMessage, ServerResponse } from 'http'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { DEPLOY_ENVS, type DeployEnv } from '../../core/domain/repositories/deploy-check-repository'

const MAX_BODY_BYTES = 64 * 1024
const NOTE_MAX = 500
const PATH = /^\/runs\/([^/]+)\/deploy-checks$/

export interface DeployChecksOptions {
  bridgeToken: string
  svc: Pick<BackendTaskService, 'getTask' | 'setDeployCheck' | 'listDeployChecks'>
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
export async function handleDeployChecksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DeployChecksOptions
): Promise<boolean> {
  const match = (req.url ?? '').split('?')[0]?.match(PATH)
  if (!match) return false
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  const goalId = decodeURIComponent(match[1])
  if (!(await opts.svc.getTask(goalId))) {
    sendJson(res, 404, { error: `unknown goal: ${goalId}` })
    return true
  }
  if (method === 'GET') {
    sendJson(res, 200, await opts.svc.listDeployChecks(goalId))
    return true
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return true
  }
  let body: { env?: unknown; itemKey?: unknown; done?: unknown; note?: unknown }
  try {
    body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof body)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }
  if (!DEPLOY_ENVS.includes(body.env as DeployEnv)) {
    sendJson(res, 400, { error: `env must be one of ${DEPLOY_ENVS.join(', ')}` })
    return true
  }
  if (typeof body.itemKey !== 'string' || body.itemKey.trim() === '') {
    sendJson(res, 400, { error: 'itemKey is required' })
    return true
  }
  if (typeof body.done !== 'boolean') {
    sendJson(res, 400, { error: 'done must be true or false' })
    return true
  }
  if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > NOTE_MAX)) {
    sendJson(res, 400, { error: `note must be a string of at most ${NOTE_MAX} characters` })
    return true
  }
  await opts.svc.setDeployCheck({
    goalTaskId: goalId,
    env: body.env as DeployEnv,
    itemKey: body.itemKey,
    done: body.done,
    doneBy: 'butter',
    note: (body.note as string | null | undefined) ?? null
  })
  sendJson(res, 200, await opts.svc.listDeployChecks(goalId))
  return true
}
