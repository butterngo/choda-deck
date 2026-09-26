// TASK-2152 — GET /activity/digests: serve the daily activity digests that
// `choda-deck activity digest` (TASK-2151) writes to <artifactsDir>/activity/.
//
// This module reads ONLY that directory. The raw transcripts the digests are
// computed from hold every prompt ever typed, so the companion never roots
// there (same stance as claude-config.ts); it serves derived numbers only.
// Digests are local files, outside every sync path (ADR-036 §5).
//
// Unlike /artifacts this is not token-gated: it follows the other read routes
// (/tasks, /conversations), which rely on the loopback bind and send no CORS
// headers, so a cross-origin page cannot read the response.

import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { activityDir, addDays } from '../../core/domain/activity/activity-runner'
import {
  localDate,
  DEFAULT_TZ,
  type ActivityDigest
} from '../../core/domain/activity/activity-digest'

export const ACTIVITY_ROUTE = '/activity/digests'
export const DEFAULT_WINDOW_DAYS = 30

export interface ActivityRouteDeps {
  artifactsDir?: string
  /** Injected so the default window is testable. */
  now?: () => Date
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A real calendar date in YYYY-MM-DD form — rejects 2026-13-01 and 2026-02-30. */
function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s)
}

type Range = { from: string; to: string } | { error: string }

export function parseRange(params: URLSearchParams, today: string): Range {
  const rawTo = params.get('to')
  const rawFrom = params.get('from')
  if (rawTo !== null && !isCalendarDate(rawTo))
    return { error: `"to" must be a YYYY-MM-DD date (got "${rawTo}")` }
  if (rawFrom !== null && !isCalendarDate(rawFrom)) {
    return { error: `"from" must be a YYYY-MM-DD date (got "${rawFrom}")` }
  }
  const to = rawTo ?? today
  const from = rawFrom ?? addDays(to, -(DEFAULT_WINDOW_DAYS - 1))
  if (from > to) return { error: `"from" (${from}) is after "to" (${to})` }
  return { from, to }
}

/** Stored digests with from <= date <= to, ascending. Unreadable files are skipped. */
export function readDigests(
  artifactsDir: string | undefined,
  from: string,
  to: string
): ActivityDigest[] {
  if (!artifactsDir) return []
  const dir = activityDir(artifactsDir)
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: ActivityDigest[] = []
  for (const name of names.sort()) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
    if (!m || m[1] < from || m[1] > to) continue
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as ActivityDigest)
    } catch {
      /* half-written or corrupt file — skip it, never 500 the whole range */
    }
  }
  return out
}

/** Returns true when it handled the request. */
export function handleActivityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ActivityRouteDeps
): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname !== ACTIVITY_ROUTE) return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const today = localDate((deps.now?.() ?? new Date()).getTime(), DEFAULT_TZ)
  const range = parseRange(url.searchParams, today)
  if ('error' in range) {
    sendJson(res, 400, { error: range.error })
    return true
  }
  sendJson(res, 200, readDigests(deps.artifactsDir, range.from, range.to))
  return true
}
