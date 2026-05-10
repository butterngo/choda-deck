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
