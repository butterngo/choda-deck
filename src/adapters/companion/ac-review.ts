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

import type { IncomingMessage, ServerResponse } from 'http'
import { AiError } from './ai-review'
import { askAzureJson, resolveAzureConfig } from './azure-review'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const AC_REVIEW_ROUTE = '/tasks/ac-review'
const MAX_BODY_BYTES = 64 * 1024

export interface AcVerdict {
  index: number
  text: string
  verdict: 'ok' | 'weak'
  /** Which of the five tests it fails, or null when ok. */
  concern: string | null
  /** A rewritten criterion to READ. Never written back. */
  suggestion: string | null
}

/**
 * The criteria, in the order `ac_check` indexes them — every `- [ ]` or `- [x]`
 * line under `## Acceptance`, and nothing else.
 *
 * Sending the whole body would grade the Context and the Test Plan too, which is
 * not what the standard is about and would spend tokens saying so. It would also
 * make the returned indexes meaningless: `ac_check` counts checkbox lines in this
 * section, and a verdict that cannot be pointed back at a checkbox is a verdict
 * nobody can act on.
 */
export function parseAcceptance(body: string): string[] {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Acceptance\s*$/i.test(l.trim()))
  if (start === -1) return []

  const out: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    // Any following h2 ends the section — ## Test Plan, ## Related, anything.
    if (/^##\s+/.test(line.trim())) break
    const m = /^\s*-\s*\[[ xX]\]\s*(.+)$/.exec(line)
    if (m && m[1] !== undefined) out.push(m[1].trim())
  }
  return out
}

const SYSTEM = [
  'You grade acceptance criteria against a fixed standard, and you report only what the standard says.',
  'A criterion is WEAK if it fails any of these five tests:',
  '(1) falsifiable — you can state in one line what a broken implementation would produce, and that output differs from the passing one;',
  '(2) observable with the surface named — it says WHERE to look: a command exit code, a response field, an artifact on disk, a rendered element.',
  'Phrases like "works correctly", "properly handles" and "is robust" name no surface and always fail this test;',
  '(3) one verdict — a criterion joined by "and" covering two separate claims is two criteria wearing one checkbox;',
  '(4) classified — it says whether verifying it needs a machine, a human, or a decision;',
  '(5) tickable — it is a checkbox line, not prose or a numbered heading.',
  'A criterion passing all five is ok.',
  'Do not invent concerns to seem useful, and do not soften a real one.',
  'For a weak criterion, name the failing test in concern and put a rewritten criterion in suggestion.',
  'For an ok criterion, concern and suggestion are both null.',
  'Answer for every criterion you are given, using its number as index.'
].join(' ')

const AC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'verdict', 'concern', 'suggestion'],
        properties: {
          index: { type: 'integer' },
          verdict: { type: 'string', enum: ['ok', 'weak'] },
          concern: { type: ['string', 'null'] },
          suggestion: { type: ['string', 'null'] }
        }
      }
    }
  }
} as const

interface RawVerdict {
  index?: number
  verdict?: string
  concern?: string | null
  suggestion?: string | null
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

  // Read the criteria BEFORE the provider is resolved, so a task with nothing to
  // grade costs nothing even on a fully configured machine. Calling a model to
  // grade an empty list is the clearest possible waste.
  const criteria = parseAcceptance(task.body ?? '')
  if (criteria.length === 0) {
    sendJson(res, 404, { error: 'no acceptance criteria' })
    return true
  }

  const cfg = opts.dataDir ? resolveAzureConfig(opts.dataDir) : null
  if (cfg === null) {
    sendJson(res, 501, { error: 'no model configured' })
    return true
  }

  try {
    const answer = await askAzureJson<{ criteria?: RawVerdict[] }>({
      cfg,
      system: SYSTEM,
      user: criteria.map((text, i) => `${i}. ${text}`).join('\n'),
      schema: AC_SCHEMA,
      schemaName: 'ac_review',
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      fetchImpl: opts.fetchImpl
    })

    const byIndex = new Map<number, RawVerdict>()
    for (const v of answer.criteria ?? []) {
      if (typeof v.index === 'number') byIndex.set(v.index, v)
    }

    // Every criterion is answered for, whether or not the model mentioned it. A
    // criterion silently missing from the response would render as approved,
    // which is the one direction this feature must never fail in.
    const out: AcVerdict[] = criteria.map((text, i) => {
      const got = byIndex.get(i)
      return {
        index: i,
        text,
        verdict: got?.verdict === 'weak' ? 'weak' : 'ok',
        concern: typeof got?.concern === 'string' ? got.concern : null,
        suggestion: typeof got?.suggestion === 'string' ? got.suggestion : null
      }
    })

    sendJson(res, 200, { criteria: out })
  } catch (err) {
    if (!(err instanceof AiError)) throw err
    if (err.kind === 'no_key') {
      sendJson(res, 501, { error: 'no model configured' })
    } else if (err.kind === 'rate_limit') {
      if (err.retryAfter) res.setHeader('retry-after', err.retryAfter)
      sendJson(res, 429, { error: err.message, kind: err.kind })
    } else {
      // The adapter's own message. A provider body can echo the key back in a
      // reflected request, and forwarding it verbatim is how a secret reaches a
      // log nobody thought was sensitive.
      sendJson(res, 502, { error: 'provider failed', kind: err.kind })
    }
  }
  return true
}
