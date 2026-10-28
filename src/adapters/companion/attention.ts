import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

// TASK-2384 — which Claude Code sessions are waiting on Butter right now, for
// the companion's decide screen. From archived digest idea INBOX-2108: on
// high-ship days context switches rose because Butter polled parallel sessions
// round-robin instead of going to the one that needed him.
//
// The data is written by the attention hook (scripts/hooks/attention.mjs,
// TASK-2383): <dataDir>/attention/<session_id>.json
//   { sessionId, cwd, state: "finished" | "waiting", since }
// and removed when Butter types into that session again. Files older than 12 h
// are ignored, so a session closed without a new prompt fades out on its own.
//
// Read-only and local (session ids and folder paths only), so GET without the
// bridge token, like the other read routes.

export const STALE_MS = 12 * 60 * 60 * 1000

export interface AttentionSession {
  sessionId: string
  cwd: string
  workspaceId: string | null
  state: 'finished' | 'waiting'
  since: string
}

export interface AttentionDeps {
  /** Unset (no data dir configured) → nothing is waiting, never a relative path. */
  dataDir?: string
  workspaces: () => Promise<{ id: string; cwd: string }[]>
  now?: () => number
}

const norm = (p: string): string =>
  path
    .resolve(p)
    .replace(/[\\/]+$/, '')
    .toLowerCase()

/** The workspace whose cwd is the longest prefix of this one, or null. */
export function workspaceForCwd(
  cwd: string,
  workspaces: { id: string; cwd: string }[]
): string | null {
  if (!cwd) return null
  const target = norm(cwd)
  let best: { id: string; len: number } | null = null
  for (const w of workspaces) {
    const root = norm(w.cwd)
    // An autopilot run works in the sibling `<root>.worktrees/<name>` (TASK-2707);
    // it belongs to the same workspace (gotcha anything-that-maps-a-cwd-to-a-workspace…).
    const worktrees = root + '.worktrees'
    const inside =
      target === root ||
      target.startsWith(root + path.sep) ||
      target.startsWith(root + '/') ||
      target.startsWith(worktrees + path.sep) ||
      target.startsWith(worktrees + '/') ||
      // A Windows cwd read on Linux (CI) keeps its '\', which is not path.sep there.
      target.startsWith(worktrees + '\\')
    if (inside && (!best || root.length > best.len)) best = { id: w.id, len: root.length }
  }
  return best?.id ?? null
}

export async function listAttention(deps: AttentionDeps): Promise<AttentionSession[]> {
  if (!deps.dataDir) return []
  const dir = path.join(deps.dataDir, 'attention')
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const now = deps.now?.() ?? Date.now()
  const workspaces = await deps.workspaces()
  const out: AttentionSession[] = []
  for (const n of names) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, n), 'utf8')
      ) as Partial<AttentionSession>
      const since = Date.parse(String(raw.since))
      if (!raw.sessionId || (raw.state !== 'finished' && raw.state !== 'waiting')) continue
      if (!Number.isFinite(since) || now - since > STALE_MS) continue
      const cwd = String(raw.cwd ?? '')
      out.push({
        sessionId: raw.sessionId,
        cwd,
        workspaceId: workspaceForCwd(cwd, workspaces),
        state: raw.state,
        since: new Date(since).toISOString()
      })
    } catch {
      // A half-written file is skipped this time and read on the next poll.
    }
  }
  return out.sort((a, b) => a.since.localeCompare(b.since))
}

/** Returns true when it handled the request. */
export async function handleAttentionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AttentionDeps
): Promise<boolean> {
  if ((req.url ?? '/').split('?')[0] !== '/attention' || req.method !== 'GET') return false
  try {
    const sessions = await listAttention(deps)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ sessions }))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
  return true
}
