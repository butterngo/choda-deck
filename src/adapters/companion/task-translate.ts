// TASK-2536 — one task's title and body in Vietnamese, for the translate button
// on the companion's task page (TASK-2537). Butter, 2026-10-19: "cái task detail
// có nút translate tiếng Việt".
//
// Bound by adr-when-this-project-may-call-a-model: this route is reached only on
// an explicit click, translates one task per call, never retries, and is not an
// MCP tool. Shape follows ac-review.ts, the other button that spends money.
//
// Two things a plain "translate this" would get wrong, both guarded here:
//   * A model translates the code too. A task body is a contract — `GET /x`,
//     `src/a.ts`, `Events:Workspaces` — and a translated identifier is a broken
//     one. Every backtick span of the source must come back verbatim, and the
//     `## ` heading count must match; otherwise the answer is refused as
//     `mangled` and never cached, so the next click asks again.
//   * Paying twice for the same text. The result is cached by a hash of the
//     English title and body, so a second click is free and an edited task is
//     translated afresh. The task itself is never written.

import type { IncomingMessage, ServerResponse } from 'http'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { askAzureJson, resolveAzureConfig, type AzureConfig } from './azure-review'
import { AiError } from './ai-review'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const ROUTE = '/tasks/translate'
const MAX_BODY_BYTES = 64 * 1024
/** A translated body is about as long as its source; review-sized budgets cut it off. */
const TRANSLATE_MAX_TOKENS = 16000

const SYSTEM = [
  'You translate software task descriptions from English to Vietnamese.',
  'Translate the prose only. Keep these exactly as they are, character for character:',
  '- every span inside backticks, inline or fenced;',
  '- file paths, URLs, and ids such as TASK-123, SESSION-…, INBOX-…, CONV-…;',
  '- Markdown structure: headings (keep the "## " prefix and translate the heading text),',
  '  list markers, checkboxes "- [ ]" and "- [x]", tables and blank lines.',
  'Return JSON with the translated title and the translated body.'
].join('\n')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: { title: { type: 'string' }, body: { type: 'string' } }
}

export interface TaskTranslateOptions {
  bridgeToken: string
  svc: Pick<BackendTaskService, 'getTask'>
  dataDir?: string
  fetchImpl?: typeof fetch
}

export interface Translation {
  taskId: string
  title: string
  body: string
  sourceHash: string
  cached: boolean
  model: string
}

export function sourceHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`, 'utf8').digest('hex')
}

/** Fenced blocks first, then inline spans outside them. */
export function codeSpans(text: string): string[] {
  const fences = text.match(/```[\s\S]*?```/g) ?? []
  const rest = text.replace(/```[\s\S]*?```/g, '')
  const inline = rest.match(/`[^`\n]+`/g) ?? []
  return [...fences, ...inline]
}

const headingCount = (text: string): number => (text.match(/^## /gm) ?? []).length

/** Null when the translation kept the code and the structure; otherwise why not. */
export function mangledReason(source: string, translated: string): string | null {
  const missing = codeSpans(source).find((span) => !translated.includes(span))
  if (missing !== undefined) return `dropped ${missing.slice(0, 60)}`
  if (headingCount(source) !== headingCount(translated)) return 'heading count differs'
  return null
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

function cachePath(dataDir: string, taskId: string, hash: string): string {
  return path.join(dataDir, 'translations', `${taskId}.${hash}.vi.json`)
}

function readCache(file: string): Omit<Translation, 'cached'> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<Translation, 'cached'>
  } catch {
    return null
  }
}

/** Returns true when it handled the request. */
export async function handleTaskTranslateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TaskTranslateOptions
): Promise<boolean> {
  if ((req.url ?? '').split('?')[0] !== ROUTE) return false

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
  let parsed: { taskId?: unknown }
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

  const body = task.body ?? ''
  const hash = sourceHash(task.title, body)
  const file = opts.dataDir ? cachePath(opts.dataDir, task.id, hash) : null
  const hit = file ? readCache(file) : null
  if (hit) {
    sendJson(res, 200, { ...hit, cached: true } satisfies Translation)
    return true
  }

  let cfg: AzureConfig | null
  try {
    cfg = opts.dataDir ? resolveAzureConfig(opts.dataDir) : null
  } catch {
    cfg = null
  }
  if (cfg === null) {
    sendJson(res, 501, { error: 'no model configured' })
    return true
  }

  let answer: { title?: unknown; body?: unknown }
  try {
    answer = await askAzureJson<typeof answer>({
      cfg,
      system: SYSTEM,
      user: `Title:\n${task.title}\n\nBody:\n${body}`,
      schema: SCHEMA,
      schemaName: 'translation',
      maxTokens: TRANSLATE_MAX_TOKENS,
      fetchImpl: opts.fetchImpl
    })
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : 'api'
    if (kind === 'rate_limit') {
      const retryAfter = err instanceof AiError ? err.retryAfter : null
      if (retryAfter) res.setHeader('retry-after', retryAfter)
      sendJson(res, 429, { error: 'rate limited', kind })
    } else if (kind === 'no_key') {
      sendJson(res, 501, { error: 'no model configured' })
    } else {
      // Never the provider's own text: a reflected request can echo the key.
      sendJson(res, 502, { error: 'provider failed', kind })
    }
    return true
  }

  if (typeof answer.title !== 'string' || typeof answer.body !== 'string') {
    sendJson(res, 502, { error: 'provider failed', kind: 'parse' })
    return true
  }
  if (mangledReason(body, answer.body) !== null) {
    sendJson(res, 502, { error: 'translation dropped code', kind: 'mangled' })
    return true
  }

  const out: Omit<Translation, 'cached'> = {
    taskId: task.id,
    title: answer.title,
    body: answer.body,
    sourceHash: hash,
    model: cfg.deployment
  }
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(out))
  }
  sendJson(res, 200, { ...out, cached: false } satisfies Translation)
  return true
}
