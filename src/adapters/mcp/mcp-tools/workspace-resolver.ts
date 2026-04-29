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

export interface ResolveWorkspaceInput {
  explicitWorkspaceId?: string
  cwd?: string
  workspaces: WorkspaceRow[]
}

export function resolveWorkspaceId(input: ResolveWorkspaceInput): string | null {
  const { explicitWorkspaceId, cwd, workspaces } = input

  if (explicitWorkspaceId) return explicitWorkspaceId

  if (workspaces.length === 0) return null

  if (!cwd) {
    const list = workspaces.map((w) => `  - ${w.id} (${w.cwd})`).join('\n')
    throw new WorkspaceResolutionError(
      `workspaceId or cwd is required — project has registered workspaces:\n${list}`
    )
  }

  const normalizedCwd = normalize(cwd)
  const matches = workspaces
    .map((w) => ({ workspace: w, normalized: normalize(w.cwd) }))
    .filter((m) => isDescendantOrEqual(m.normalized, normalizedCwd))
    .sort((a, b) => b.normalized.length - a.normalized.length)

  if (matches.length === 0) {
    const list = workspaces.map((w) => `  - ${w.id} (${w.cwd})`).join('\n')
    throw new WorkspaceResolutionError(
      `cwd ${cwd} does not match any registered workspace — pass workspaceId or call workspace_add. Registered:\n${list}`
    )
  }

  return matches[0].workspace.id
}
