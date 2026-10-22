// TASK-2607 — "Copy value" for a deploy checklist secret (Butter, 2026-10-21:
// the value goes to the clipboard and is never rendered or logged).
//
//   POST /secrets/copy  { workspaceId, file, field }  →  200 { value }, cache-control: no-store
//
// Guards, in order: bridge token (401), loopback caller (403), a known workspace
// (404), a file inside <workspace cwd>/sensitive_information/ (400), the file
// (404 `file not found`), the `field=` line (404 `field not found: <field>`).
// A refusal names the field, never a value. The handler's log records the route,
// the status and the field name — the value is never handed to it.
//
// The field reader assumes `name=value` lines; nobody read a real secret file to
// learn its shape (memory: never print sensitive_information/ files).

import type { IncomingMessage, ServerResponse } from 'http'
import * as fs from 'fs'
import * as path from 'path'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const MAX_BODY_BYTES = 16 * 1024
const SENSITIVE_DIR = 'sensitive_information'
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export interface SecretsCopyLogEvent {
  route: '/secrets/copy'
  status: number
  field?: string
}

export interface SecretsCopyOptions {
  bridgeToken: string
  svc: Pick<BackendTaskService, 'getWorkspace'>
  /** Where the route reports what it did. Never receives a value. */
  log?: (event: SecretsCopyLogEvent) => void
}

function send(res: ServerResponse, status: number, body: unknown, log: SecretsCopyOptions['log'], field?: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
  log?.({ route: '/secrets/copy', status, ...(field ? { field } : {}) })
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

/** The value of the first `field=value` line, or null. */
export function readField(text: string, field: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const i = raw.indexOf('=')
    if (i <= 0) continue
    if (raw.slice(0, i).trim() === field) return raw.slice(i + 1).trim()
  }
  return null
}

/** Returns true when it handled the request. */
export async function handleSecretsCopyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: SecretsCopyOptions
): Promise<boolean> {
  if ((req.url ?? '').split('?')[0] !== '/secrets/copy') return false
  const log = opts.log
  if ((req.method ?? 'GET') !== 'POST') return (send(res, 405, { error: 'POST only' }, log), true)
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    return (send(res, 401, { error: 'invalid or missing x-choda-bridge-token' }, log), true)
  }
  if (!LOOPBACK.has(req.socket?.remoteAddress ?? '')) {
    return (send(res, 403, { error: 'only this machine may copy a secret' }, log), true)
  }

  const raw = await readBody(req)
  if (raw === null) return (send(res, 413, { error: 'too large' }, log), true)
  let body: { workspaceId?: unknown; file?: unknown; field?: unknown }
  try {
    body = JSON.parse(raw.toString('utf8')) as typeof body
  } catch {
    return (send(res, 400, { error: 'body is not valid JSON' }, log), true)
  }
  const { workspaceId, file, field } = body
  if (typeof workspaceId !== 'string' || typeof file !== 'string' || typeof field !== 'string' || field === '') {
    return (send(res, 400, { error: 'workspaceId, file and field are required' }, log), true)
  }
  const ws = await opts.svc.getWorkspace(workspaceId)
  if (!ws) return (send(res, 404, { error: `unknown workspace: ${workspaceId}` }, log), true)

  const dir = path.resolve(ws.cwd, SENSITIVE_DIR)
  const target = path.resolve(ws.cwd, file)
  if (!target.startsWith(dir + path.sep)) {
    return (send(res, 400, { error: `file must be under ${SENSITIVE_DIR}/` }, log, field), true)
  }
  let text: string
  try {
    text = await fs.promises.readFile(target, 'utf8')
  } catch {
    return (send(res, 404, { error: 'file not found' }, log, field), true)
  }
  const value = readField(text, field)
  if (value === null) return (send(res, 404, { error: `field not found: ${field}` }, log, field), true)
  send(res, 200, { value }, log, field)
  return true
}
