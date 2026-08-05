// TASK-1566 — serve capture artifacts to the companion web app. Screenshots, HAR
// bundles and discovery dirs are written to `<dataDir>/artifacts/captures/` by
// capture-dispatcher, but nothing could read them back: this module is the only
// route on the companion surface that streams bytes instead of JSON.
//
// Token-gated, unlike the other read routes. These files carry cookies,
// Authorization headers, screenshots and DOM dumps — see the gotcha
// `secret-carrying-capture-kinds-are-local-only-never-inbox-task`. The web app
// needs no change: its static proxy already injects x-choda-bridge-token on /api/*.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

const ROUTE_PREFIX = '/artifacts/'

// Extensions the capture pipeline actually produces (capture-artifacts.ts +
// discovery-artifacts.ts). Anything else is served as an opaque download rather
// than guessing a type a browser might render.
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.har': 'application/json',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same constant-time compare as http-server's capture gate, duplicated rather
// than exported so this module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

/**
 * True when a decoded relative path contains any traversal or absolute segment.
 *
 * This is checked on the RAW request path, deliberately. `new URL()` collapses
 * dot segments before a handler ever sees them — `/artifacts/../../database/x.db`
 * normalizes to `/database/x.db`, which would silently fall through to the
 * router's 404 instead of being refused. Routing off the raw URL keeps the
 * refusal explicit and does not depend on the parser's normalization behaviour.
 */
function hasTraversal(relDecoded: string): boolean {
  if (path.isAbsolute(relDecoded) || /^[a-z]:/i.test(relDecoded)) return true
  return relDecoded
    .split(/[/\\]/)
    .some((seg) => seg === '..' || seg === '.' || seg.trim() === '')
}

/**
 * GET /artifacts/<relative path under the artifacts dir>.
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleTaskDetailRoute / handleKnowledgeRoute).
 */
export function handleArtifactsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { artifactsDir?: string; bridgeToken: string }
): boolean {
  // Match on the raw URL, not url.pathname — see hasTraversal above.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (!rawPath.startsWith(ROUTE_PREFIX)) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  // Symmetric with POST /capture's 501 when no dispatcher is wired: the request
  // was well-formed, the server just isn't configured to answer it.
  if (!opts.artifactsDir) {
    sendJson(res, 501, { error: 'artifact serving not configured' })
    return true
  }

  let rel: string
  try {
    rel = decodeURIComponent(rawPath.slice(ROUTE_PREFIX.length))
  } catch {
    sendJson(res, 400, { error: 'malformed percent-encoding in path' })
    return true
  }
  if (rel.length === 0 || hasTraversal(rel)) {
    sendJson(res, 403, { error: 'path escapes the artifacts directory' })
    return true
  }

  const root = path.resolve(opts.artifactsDir)
  const target = path.resolve(root, rel)
  // Belt-and-braces after the segment check: a symlink or an encoding the
  // segment scan missed still cannot land outside the root.
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendJson(res, 403, { error: 'path escapes the artifacts directory' })
    return true
  }

  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    sendJson(res, 404, { error: 'artifact not found' })
    return true
  }
  if (!stat.isFile()) {
    sendJson(res, 404, { error: 'artifact not found' })
    return true
  }

  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': String(stat.size) })
  fs.createReadStream(target).pipe(res)
  return true
}
