// TASK-1749 — browse a workspace's own .md docs. A workspace already carries its
// cwd, so picking one is the whole configuration; nothing else needs setting up.
//
// Read-only, always. Listing was .md-only until TASK-1787; it now serves the
// whole tree when asked, because an audit view that can name the files a commit
// touched and then not open them is only half a chain.
//
// The old comment here cited ADR-033 as the reason for the .md limit. That was a
// misattribution and is corrected rather than deleted: ADR-033 retired GRAPHIFY
// — an external tool emitting a symbol graph of functions, imports and calls —
// and declined to fold it into the unified store because that store has no AST
// layer. Reading a .ts file's TEXT is a different act, and ADR-033 is silent on
// it. The limit was a real scope choice; the reason attached to it was borrowed.
//
// Two things measured on 2026-08-22 shape this module:
//
//   1. node_modules dwarfs the real docs. choda-deck is 199 .md files, or 877 if
//      node_modules counts; the companion is 26 against 979. Walking without a
//      filter would bury the workspace's own docs under vendored READMEs.
//   2. The largest .md in the tree is 54,553 bytes, so a single synchronous scan
//      and a whole-file read are both fine at this scale. No cache, no paging.
//
// Token-gated and matched on the RAW url, mirroring artifacts.ts and vault.ts —
// see hasTraversal for why `new URL()` normalization cannot be trusted here.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const LIST_ROUTE = '/workspace-docs'
const FILE_ROUTE_PREFIX = '/workspace-docs/'

/**
 * Directories never worth walking into. node_modules is the load-bearing one —
 * it is 678 of choda-deck's 877 .md files. The rest are the usual build and VCS
 * noise that would otherwise show up as "docs".
 */
/**
 * Extensions served as bytes, not text. Decided by EXTENSION, not by sniffing
 * content: a .png is binary whatever its first bytes happen to look like, and a
 * content guess would disagree with itself across platforms and locales.
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.node',
  '.db', '.sqlite', '.sqlite3', '.onnx', '.bin', '.wasm',
  '.mp4', '.mp3', '.wav', '.mov', '.webm'
])

/** True when this path should never be handed back as a string. */
export function isBinaryPath(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXT.has(relPath.slice(dot).toLowerCase())
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', 'release'])

export interface WorkspaceDoc {
  /** Path relative to the workspace cwd, always forward-slashed. */
  path: string
  size: number
  modifiedAt: string
  /** TASK-1787 — listed, but never served as text. Absent means false. */
  binary?: boolean
}

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

/**
 * True when a decoded relative path contains any traversal or absolute segment.
 * Checked on the RAW request path: `new URL()` collapses dot segments before a
 * handler sees them, which would turn a refusal into a silent 404 elsewhere.
 */
function hasTraversal(relDecoded: string): boolean {
  if (path.isAbsolute(relDecoded) || /^[a-z]:/i.test(relDecoded)) return true
  return relDecoded
    .split(/[/\\]/)
    .some((seg) => seg === '..' || seg === '.' || seg.trim() === '')
}

/** Resolve `rel` under `root`, or null if it would escape. */
function safeResolve(root: string, rel: string): string | null {
  if (rel.length === 0 || hasTraversal(rel)) return null
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, rel)
  // Belt-and-braces after the segment scan: a symlink or an encoding the scan
  // missed still cannot land outside the root.
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return null
  return target
}

/** What a listing collects. `md` is the default and is unchanged from TASK-1749. */
export type IncludeMode = 'md' | 'all'

/**
 * Depth-first walk, skipping the vendored/build dirs.
 *
 * `md` collects markdown only. `all` collects every file, marking the ones that
 * must not be served as text. SKIP_DIRS does the heavy lifting in both modes —
 * without it `all` would be dominated by node_modules, which is the whole reason
 * that set exists.
 */
export function listWorkspaceDocs(cwd: string, include: IncludeMode = 'md'): WorkspaceDoc[] {
  const docs: WorkspaceDoc[] = []
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // an unreadable subdirectory drops out; it is not the whole listing's problem
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name), childRel)
        continue
      }
      if (!entry.isFile()) continue
      if (include === 'md' && !entry.name.toLowerCase().endsWith('.md')) continue
      try {
        const stat = fs.statSync(path.join(dir, entry.name))
        const doc: WorkspaceDoc = {
          path: childRel,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString()
        }
        if (isBinaryPath(childRel)) doc.binary = true
        docs.push(doc)
      } catch {
        // a file that vanished mid-walk is simply not listed
      }
    }
  }
  walk(path.resolve(cwd), '')
  return docs.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * GET /workspace-docs?workspaceId=<id>           -> { workspaceId, cwd, docs: [WorkspaceDoc] }
 * GET /workspace-docs/<workspaceId>/<rel path>   -> text/markdown
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleVaultRoute / handleArtifactsRoute).
 */
export async function handleWorkspaceDocsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { svc: WorkspaceOperations; bridgeToken: string }
): Promise<boolean> {
  // Match on the raw URL, not url.pathname — see hasTraversal.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== LIST_ROUTE && !rawPath.startsWith(FILE_ROUTE_PREFIX)) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  if (rawPath === LIST_ROUTE) {
    const workspaceId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('workspaceId')
    if (!workspaceId) {
      sendJson(res, 400, { error: 'workspaceId is required' })
      return true
    }
    const workspace = await opts.svc.getWorkspace(workspaceId)
    if (!workspace) {
      sendJson(res, 404, { error: `unknown workspace: ${workspaceId}` })
      return true
    }
    // A workspace whose cwd is gone is a FAILURE, not an empty docs list — the
    // view must be able to say "the folder for <label> isn't there" rather than
    // "no docs", which reads as a fact about the repo.
    if (!fs.existsSync(workspace.cwd)) {
      sendJson(res, 409, {
        error: 'workspace cwd does not exist',
        workspaceId,
        label: workspace.label,
        cwd: workspace.cwd
      })
      return true
    }
    // Default stays `md`. The companion talks to a VENDORED adapter bundle that
    // refreshes only at release (INBOX-1888), so an older adapter must ignore
    // `include=all` and answer as it always did. Flipping the default would make
    // a new client's tree silently wrong against an old adapter instead.
    const includeRaw = new URL(req.url ?? '/', 'http://localhost').searchParams.get('include')
    if (includeRaw !== null && includeRaw !== 'md' && includeRaw !== 'all') {
      sendJson(res, 400, { error: "include must be 'md' or 'all'" })
      return true
    }
    const include: IncludeMode = includeRaw === 'all' ? 'all' : 'md'
    sendJson(res, 200, {
      workspaceId,
      label: workspace.label,
      cwd: workspace.cwd,
      docs: listWorkspaceDocs(workspace.cwd, include)
    })
    return true
  }

  // /workspace-docs/<workspaceId>/<rel...>
  const rest = rawPath.slice(FILE_ROUTE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) {
    sendJson(res, 400, { error: 'expected /workspace-docs/<workspaceId>/<path>' })
    return true
  }
  const workspaceId = decodeURIComponent(rest.slice(0, slash))
  // Decode for the guard, but the guard also ran conceptually on the raw form:
  // the segment scan below rejects `..` however it arrived.
  const rel = decodeURIComponent(rest.slice(slash + 1))

  // TASK-1787 — any text file, but a binary one is REFUSED rather than decoded.
  // Reading a .png as utf8 produces a string; it is just not the file, and a
  // viewer showing replacement characters would look like a rendering bug rather
  // than a category error.
  if (isBinaryPath(rel)) {
    sendJson(res, 415, { error: 'binary files are listed but not served as text', path: rel })
    return true
  }

  const workspace = await opts.svc.getWorkspace(workspaceId)
  if (!workspace) {
    sendJson(res, 404, { error: `unknown workspace: ${workspaceId}` })
    return true
  }

  const target = safeResolve(workspace.cwd, rel)
  if (!target) {
    sendJson(res, 400, { error: 'invalid path' })
    return true
  }
  if (!fs.existsSync(target)) {
    sendJson(res, 404, { error: `not found: ${rel}` })
    return true
  }

  const isMd = rel.toLowerCase().endsWith('.md')
  res.writeHead(200, {
    'content-type': isMd ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
  })
  res.end(fs.readFileSync(target, 'utf8'))
  return true
}
