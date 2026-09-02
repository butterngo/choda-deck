// TASK-1797 — answer "where is this name declared?" for one workspace.
//
// The companion can already open a file and mark a line (TASK-1792/1794). What
// it could not do is follow what a line CALLS: reading
// `.AddEndpointFilter<Auth.ServiceTokenWorkspaceFilter>()`, there was no way to
// reach the class. This route closes that hop.
//
// It is a TEXT scan, and that is a decision rather than a shortcut. ADR-033
// retired the AST code-symbol graph and refused to fold it into the unified
// store, because that store has no AST layer — `code_ref` is a file/symbol
// POINTER, with no call or import graph to walk. Rebuilding one here would
// re-open a decision closed on 2026-06-04. Reading a file's text is a different
// act, the same distinction workspace-docs.ts:8-13 already draws.
//
// Two measurements from 2026-09-02 say a live scan is enough, so there is no
// index, no cache and no background job:
//
//   1. 994 files in choda-deck (after SKIP_DIRS) walked in 0.10s.
//   2. A full .cs definition scan over the bpa-engine checkout took 0.17s.
//
// The walk itself is `listWorkspaceDocs(cwd, 'all')` rather than a second
// implementation: it already skips node_modules — 678 of choda-deck's 877 .md
// files — and already marks the files that must never be read as text.
//
// Token-gated and matched on the RAW url, mirroring workspace-docs.ts.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'
import { listWorkspaceDocs } from './workspace-docs'

const ROUTE = '/workspace-symbols'

/**
 * The keywords that turn an occurrence into a DECLARATION.
 *
 * This set is the whole heuristic. Anchoring on a preceding keyword is what
 * separates `public sealed class ServiceTokenWorkspaceFilter : IEndpointFilter`
 * from the dozens of call sites and comments that mention the same name — a
 * plain name search would return every one of them and the reader would have to
 * do the filtering the tool exists to do.
 *
 * Modifiers do not need listing: the anchor is the keyword immediately before
 * the name, so `public sealed class X` and `class X` match identically.
 */
const DEFINITION_KEYWORDS = [
  'class',
  'record',
  'interface',
  'struct',
  'enum',
  'type',
  'function',
  'def',
  'func'
] as const

/** Files bigger than this are skipped rather than read into memory. */
const MAX_SCAN_BYTES = 2_000_000

export interface SymbolMatch {
  /** Workspace-relative, forward-slashed — the same shape listWorkspaceDocs emits. */
  path: string
  /** 1-based, so it feeds the viewer's existing `#L<n>` anchor unchanged. */
  line: number
  /** The keyword that anchored the match. */
  kind: string
  /** The matched source line, trimmed. */
  text: string
}

/**
 * True for a name this route is willing to search for.
 *
 * Not merely validation: the name is interpolated into a RegExp below, so a
 * caller passing `.*` would otherwise turn a definition lookup into a scan that
 * matches every declaration in the repo. Restricting to identifier characters
 * makes the interpolation safe by construction rather than by escaping.
 */
export function isSearchableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** The declaration pattern for one name. Exported so the tests can prove the anchor. */
export function definitionPattern(name: string): RegExp {
  return new RegExp(`\\b(${DEFINITION_KEYWORDS.join('|')})\\s+${name}\\b`)
}

/**
 * Every declaration of `name` under `cwd`, ordered by path then line.
 *
 * Binary files are skipped rather than decoded: reading a .png as utf8 yields a
 * string, and that string can contain the searched name by coincidence. The
 * extension already decides this in workspace-docs, so the decision is not
 * re-litigated here.
 */
export function scanWorkspaceSymbols(cwd: string, name: string): SymbolMatch[] {
  if (!isSearchableName(name)) return []
  const pattern = definitionPattern(name)
  const matches: SymbolMatch[] = []

  for (const doc of listWorkspaceDocs(cwd, 'all')) {
    if (doc.binary === true) continue
    if (doc.size > MAX_SCAN_BYTES) continue
    let content: string
    try {
      content = fs.readFileSync(path.join(cwd, doc.path), 'utf8')
    } catch {
      continue // a file that vanished or is unreadable mid-scan is simply not searched
    }
    // A cheap reject before splitting: most files do not contain the name at
    // all, and splitting every file into lines is the expensive half.
    if (!content.includes(name)) continue
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const hit = pattern.exec(line)
      if (hit === null) continue
      matches.push({
        path: doc.path,
        line: i + 1,
        kind: hit[1] ?? '',
        text: line.trim()
      })
    }
  }
  return matches
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same constant-time compare as the artifacts, vault and workspace-docs gates,
// duplicated rather than exported so this module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

/**
 * GET /workspace-symbols?workspaceId=<id>&name=<Symbol>
 *   -> { workspaceId, label, cwd, name, matches: [SymbolMatch] }
 *
 * An empty `matches` is a 200, never a 404: a name may legitimately be a local,
 * a keyword, or declared in a different workspace, and those are ordinary
 * answers rather than failures.
 *
 * The 404 for an unknown workspace NAMES that workspace, which is load-bearing
 * beyond politeness: `/healthz` carries no capability list, so a companion
 * talking to an older vendored adapter (INBOX-1888) receives the router's own
 * `{ error: 'not found' }` for this path. The body is the only thing separating
 * "you asked for a workspace that does not exist" from "this adapter is too old
 * to have the route", and the web side depends on that distinction.
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleWorkspaceDocsRoute).
 */
export async function handleWorkspaceSymbolsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { svc: WorkspaceOperations; bridgeToken: string }
): Promise<boolean> {
  // Match on the raw URL, not url.pathname — see workspace-docs' hasTraversal.
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== ROUTE) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const params = new URL(req.url ?? '/', 'http://localhost').searchParams
  const workspaceId = params.get('workspaceId')
  if (!workspaceId) {
    sendJson(res, 400, { error: 'workspaceId is required' })
    return true
  }
  // Validated BEFORE the workspace lookup and therefore before any filesystem
  // walk: a malformed request should cost nothing.
  const name = (params.get('name') ?? '').trim()
  if (name.length === 0) {
    sendJson(res, 400, { error: 'name is required' })
    return true
  }
  if (!isSearchableName(name)) {
    sendJson(res, 400, { error: 'name must be an identifier', name })
    return true
  }

  const workspace = await opts.svc.getWorkspace(workspaceId)
  if (!workspace) {
    sendJson(res, 404, { error: `unknown workspace: ${workspaceId}` })
    return true
  }
  // A workspace whose cwd is gone is a FAILURE, not zero matches — "no
  // definition found" and "the folder isn't there" are different answers and
  // the reader has to be able to tell them apart.
  if (!fs.existsSync(workspace.cwd)) {
    sendJson(res, 409, {
      error: 'workspace cwd does not exist',
      workspaceId,
      label: workspace.label,
      cwd: workspace.cwd
    })
    return true
  }

  sendJson(res, 200, {
    workspaceId,
    label: workspace.label,
    cwd: workspace.cwd,
    name,
    matches: scanWorkspaceSymbols(workspace.cwd, name)
  })
  return true
}
