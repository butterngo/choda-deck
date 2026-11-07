import * as path from 'path'
import { WorkspaceResolutionError } from '../../../core/domain/lifecycle/errors'
import type { WorkspaceRow } from '../../../core/domain/repositories/workspace-repository'

const isWindows = process.platform === 'win32'

function normalize(p: string): string {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '')
  return isWindows ? resolved.toLowerCase().replace(/\//g, '\\') : resolved
}

function isDescendantOrEqual(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  return !path.isAbsolute(rel)
}

// TASK-2726 — a run worktree lives BESIDE its workspace, at
// `<workspaceCwd>.worktrees/<name>` (src/core/worktree-path.ts). Returns the
// normalized worktree root when `cwd` is inside one of `wsCwd`'s worktrees,
// else null. The `.worktrees` folder itself is not a checkout.
function worktreeRootFor(wsCwd: string, cwd: string): string | null {
  const base = `${wsCwd}.worktrees`
  if (cwd === base || !isDescendantOrEqual(base, cwd)) return null
  return path.join(base, path.relative(base, cwd).split(/[\\/]/)[0])
}

/** Length of the checkout `cwd` sits in for workspace `wsCwd`, or -1 when it is in none. */
function matchedRootLength(wsCwd: string, cwd: string): number {
  if (isDescendantOrEqual(wsCwd, cwd)) return wsCwd.length
  return worktreeRootFor(wsCwd, cwd)?.length ?? -1
}

export interface ResolveWorkspaceInput {
  explicitWorkspaceId?: string
  cwd?: string
  workspaces: WorkspaceRow[]
}

export function resolveWorkspaceId(input: ResolveWorkspaceInput): string | null {
  const { explicitWorkspaceId, cwd, workspaces } = input

  // TASK-3142 — an explicit id must name a registered, non-archived workspace of
  // this project (`workspaces` excludes archived rows). Returning it unchecked
  // bound a session to a workspace that does not exist, and every later
  // ac_check from its cwd failed with SESSION_MISMATCH.
  if (explicitWorkspaceId) {
    if (workspaces.some((w) => w.id === explicitWorkspaceId)) return explicitWorkspaceId
    const list = workspaces.map((w) => `  - ${w.id} (${w.cwd})`).join('\n') || '  (none)'
    throw new WorkspaceResolutionError(
      `workspaceId ${explicitWorkspaceId} is not a registered workspace of this project — pick one below or call workspace_add:\n${list}`
    )
  }

  if (workspaces.length === 0) return null

  if (!cwd) {
    const list = workspaces.map((w) => `  - ${w.id} (${w.cwd})`).join('\n')
    throw new WorkspaceResolutionError(
      `workspaceId or cwd is required — project has registered workspaces:\n${list}`
    )
  }

  const normalizedCwd = normalize(cwd)
  const matches = workspaces
    .map((w) => ({ workspace: w, rootLength: matchedRootLength(normalize(w.cwd), normalizedCwd) }))
    .filter((m) => m.rootLength >= 0)
    .sort((a, b) => b.rootLength - a.rootLength)

  if (matches.length === 0) {
    const list = workspaces.map((w) => `  - ${w.id} (${w.cwd})`).join('\n')
    throw new WorkspaceResolutionError(
      `cwd ${cwd} does not match any registered workspace — pass workspaceId or call workspace_add. Registered:\n${list}`
    )
  }

  return matches[0].workspace.id
}
