import * as fs from 'fs'
import * as path from 'path'
import { canonicalJson } from './canonical-json'
import type { WorkspaceIdentity } from './snapshot-types'

export const PATHS_MAPPING_VERSION = 1
export const PATHS_MAPPING_FILE = 'paths.local.json'

export interface PathsMapping {
  version: number
  mappings: Record<string, string>
}

/**
 * Stable string key for a workspace identity.
 *
 * Git-backed: `<canonical_git_remote>:<repo_relative_workspace_path>`
 * Non-git: the identity's `localFallbackKey` (already prefixed `local:`)
 *
 * Throws if the identity is incomplete (no git remote AND no fallback key).
 */
export function identityKey(identity: WorkspaceIdentity): string {
  if (identity.canonicalGitRemote && identity.repoRelativeWorkspacePath !== null) {
    return `${identity.canonicalGitRemote}:${identity.repoRelativeWorkspacePath}`
  }
  if (identity.localFallbackKey) return identity.localFallbackKey
  throw new Error(
    `identityKey: workspace ${identity.workspaceId} has no canonical remote and no fallback key`
  )
}

export function pathsMappingFile(dataDir: string): string {
  return path.join(dataDir, PATHS_MAPPING_FILE)
}

export function loadPathsMapping(dataDir: string): PathsMapping {
  const file = pathsMappingFile(dataDir)
  if (!fs.existsSync(file)) return { version: PATHS_MAPPING_VERSION, mappings: {} }
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = JSON.parse(raw) as PathsMapping
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`paths-mapping: invalid file ${file}`)
  }
  if (parsed.version !== PATHS_MAPPING_VERSION) {
    throw new Error(
      `paths-mapping: unsupported version ${parsed.version} in ${file} (expected ${PATHS_MAPPING_VERSION})`
    )
  }
  return { version: parsed.version, mappings: parsed.mappings ?? {} }
}

/**
 * Write the mapping atomically: write to a sibling temp file, then rename.
 * `fs.renameSync` is atomic on the same filesystem on POSIX and on NTFS.
 */
export function savePathsMapping(dataDir: string, mapping: PathsMapping): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const file = pathsMappingFile(dataDir)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, canonicalJson(mapping), 'utf8')
  fs.renameSync(tmp, file)
}

export function setMapping(mapping: PathsMapping, key: string, cwd: string): PathsMapping {
  return {
    version: mapping.version,
    mappings: { ...mapping.mappings, [key]: cwd }
  }
}
