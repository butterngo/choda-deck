/**
 * Wire types for the cross-device sync snapshot format.
 *
 * The snapshot is a directory of JSON files written by `choda-deck sync export`
 * and consumed by `choda-deck sync import`. Each file is canonical JSON with
 * sorted keys, LF line endings, and a trailing newline (see `canonical-json.ts`).
 *
 * Manifest is written LAST, so a partial export is detectable by readers
 * (no manifest = treat the snapshot as invalid).
 */

export const EXPORT_FORMAT_VERSION = 1

export const SNAPSHOT_FILES = [
  'projects.json',
  'workspaces.json',
  'tasks.json',
  'conversations.json',
  'inbox.json',
  'sessions.json',
  'knowledge.json'
] as const

export type SnapshotFileName = (typeof SNAPSHOT_FILES)[number]

/**
 * Workspace identity — stable across machines for the same logical workspace.
 *
 * For git-tracked workspaces:
 *   identity = canonical_git_remote + repo_relative_workspace_path
 *
 * Worktrees of the same repo share identity (same `--git-common-dir`).
 *
 * For non-git workspaces, `canonicalGitRemote` is `null` and the caller falls
 * back to `local:<projectId>:<workspaceId>` as the identity key.
 */
export interface WorkspaceIdentity {
  workspaceId: string
  projectId: string
  canonicalGitRemote: string | null
  repoRelativeWorkspacePath: string | null
  localFallbackKey: string | null
}

export interface SnapshotManifest {
  exportFormatVersion: number
  appVersion: string
  exportedAt: string
  contentHash: string
  projectIds: string[]
  workspaceIdentities: WorkspaceIdentity[]
  includesArtifacts: false
}

/**
 * Domain payload — the in-memory shape that gets serialized per file.
 * The export-service builds this from the live DB; the import-service
 * applies it back.
 */
export interface SnapshotPayload {
  projects: unknown[]
  workspaces: unknown[]
  tasks: unknown[]
  conversations: unknown[]
  inbox: unknown[]
  sessions: unknown[]
  knowledge: unknown[]
}

export interface ExportResult {
  status: 'no-op' | 'metadata-refresh' | 'written'
  outDir: string
  contentHash: string
  manifestPath: string
  filesWritten: string[]
}
