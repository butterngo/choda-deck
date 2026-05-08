import { execFileSync } from 'child_process'
import * as path from 'path'
import { canonicalGitRemote } from './canonical-remote'
import type { WorkspaceIdentity } from './snapshot-types'

/**
 * Thin abstraction over git CLI commands so tests can inject a fake.
 * Each method returns `null` when the command fails (non-zero exit, no output,
 * not a git folder, missing remote, etc.) so callers handle one shape.
 */
export interface GitCommands {
  gitCommonDir(cwd: string): string | null
  showToplevel(cwd: string): string | null
  getRemoteOrigin(cwd: string): string | null
}

export function realGitCommands(): GitCommands {
  return {
    gitCommonDir: (cwd) => runGit(['rev-parse', '--git-common-dir'], cwd),
    showToplevel: (cwd) => runGit(['rev-parse', '--show-toplevel'], cwd),
    getRemoteOrigin: (cwd) => runGit(['remote', 'get-url', 'origin'], cwd)
  }
}

function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const trimmed = out.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

export interface WorkspaceInput {
  id: string
  cwd: string
}

/**
 * Compute the cross-machine identity of a workspace.
 *
 * Git-tracked path:
 *   1. `--git-common-dir` resolves the **shared** `.git` directory
 *      (same across all worktrees of the same repo). Resolved against
 *      `cwd` because some Windows git versions return a relative path.
 *   2. `--show-toplevel` resolves the **physical** repo root for this
 *      checkout (the worktree root if inside a worktree, else main checkout).
 *   3. `remote get-url origin` on the logical repo root yields the raw URL,
 *      which is canonicalised via `canonicalGitRemote()`.
 *   4. `repoRelativeWorkspacePath` = workspace.cwd relative to physical root,
 *      normalised to forward slashes so the same logical path matches
 *      across Windows and POSIX.
 *
 * Non-git path: identity falls back to `local:<projectId>:<workspaceId>`.
 *
 * Worktree behaviour: workspaces in `<repo>/<sub>` and `<repo>.worktrees/<branch>/<sub>`
 * resolve to the **same** identity — both share `--git-common-dir` and both
 * compute `repoRelativeWorkspacePath` against their own `--show-toplevel`.
 */
export function computeWorkspaceIdentity(
  workspace: WorkspaceInput,
  projectId: string,
  git: GitCommands = realGitCommands()
): WorkspaceIdentity {
  const commonDir = git.gitCommonDir(workspace.cwd)
  if (commonDir === null) {
    return localFallback(workspace, projectId)
  }

  const physicalRoot = git.showToplevel(workspace.cwd)
  if (physicalRoot === null) {
    return localFallback(workspace, projectId)
  }

  const resolvedCommonDir = path.resolve(workspace.cwd, commonDir)
  const logicalRepoRoot = path.dirname(resolvedCommonDir)

  const remoteUrl = git.getRemoteOrigin(logicalRepoRoot)
  if (remoteUrl === null) {
    return localFallback(workspace, projectId)
  }

  let canonical: string
  try {
    canonical = canonicalGitRemote(remoteUrl)
  } catch {
    return localFallback(workspace, projectId)
  }

  const relPath = path.relative(physicalRoot, workspace.cwd).replace(/\\/g, '/')

  return {
    workspaceId: workspace.id,
    projectId,
    canonicalGitRemote: canonical,
    repoRelativeWorkspacePath: relPath,
    localFallbackKey: null
  }
}

function localFallback(workspace: WorkspaceInput, projectId: string): WorkspaceIdentity {
  return {
    workspaceId: workspace.id,
    projectId,
    canonicalGitRemote: null,
    repoRelativeWorkspacePath: null,
    localFallbackKey: `local:${projectId}:${workspace.id}`
  }
}

/**
 * Compute identities for a list of workspaces, deduping by logical repo root.
 *
 * Within one export pass, only one git remote lookup happens per logical
 * repo (cached by common-dir path) — avoids spawning N `git remote` calls
 * for monorepos with N workspaces in the same checkout.
 */
export function computeWorkspaceIdentities(
  workspaces: WorkspaceInput[],
  workspaceProjectId: (workspace: WorkspaceInput) => string,
  git: GitCommands = realGitCommands()
): WorkspaceIdentity[] {
  const remoteCache = new Map<string, string | null>()
  const cachedGit: GitCommands = {
    gitCommonDir: (cwd) => git.gitCommonDir(cwd),
    showToplevel: (cwd) => git.showToplevel(cwd),
    getRemoteOrigin: (cwd) => {
      const key = path.resolve(cwd)
      if (remoteCache.has(key)) return remoteCache.get(key) ?? null
      const url = git.getRemoteOrigin(cwd)
      remoteCache.set(key, url)
      return url
    }
  }
  return workspaces.map((w) => computeWorkspaceIdentity(w, workspaceProjectId(w), cachedGit))
}
