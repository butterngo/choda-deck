import * as path from 'path'

const WORKTREE_SEGMENT_RE = /\.worktrees([\\/]|$)/i

/**
 * Heuristic detector for git-worktree ephemeral checkouts.
 *
 * Returns true when `absPath` contains a `.worktrees` directory segment
 * (case-insensitive) — the convention used in `CLAUDE.md` where worktrees
 * live under `<repo>.worktrees/<branch>/`. This is a project-local
 * heuristic; a stronger detector would shell out to `git worktree list`
 * but that is deferred to keep hot write paths free of git invocations.
 */
export function isLikelyWorktreePath(absPath: string): boolean {
  if (!absPath) return false
  const normalized = path.normalize(absPath)
  return WORKTREE_SEGMENT_RE.test(normalized)
}

const slashes = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * TASK-2790 — the checkout a command run from `cwd` belongs to, for a home
 * workspace at `homeCwd`. A run worktree lives BESIDE its workspace at
 * `<homeCwd>.worktrees/<name>` (the same convention workspace-resolver.ts
 * follows for MCP since TASK-2726), so a cwd anywhere inside one returns that
 * worktree's root; any other cwd, the registered checkout included, returns
 * `homeCwd`. The bare `.worktrees` folder is not a checkout.
 *
 * Pure string work, no `path.resolve`: a Windows path must compare the same way
 * when the tests run on Linux CI. Drive-letter paths (and win32) compare
 * case-insensitively, and `\` and `/` are treated alike.
 */
export function checkoutRootFor(homeCwd: string, cwd: string): string {
  const fold = process.platform === 'win32' || /^[a-z]:/i.test(homeCwd)
  const key = (p: string): string => (fold ? slashes(p).toLowerCase() : slashes(p))
  const base = `${key(homeCwd)}.worktrees/`
  const c = slashes(cwd)
  if (!key(c).startsWith(base)) return homeCwd
  const name = c.slice(base.length).split('/')[0]
  if (!name) return homeCwd
  const root = c.slice(0, base.length + name.length)
  return cwd.includes('\\') ? root.replace(/\//g, '\\') : root
}
