import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import type Database from 'better-sqlite3'

import { canonicalJson } from './canonical-json'
import { dumpProjectsScope, type SnapshotDump } from './db-dumper'
import {
  computeWorkspaceIdentities,
  realGitCommands,
  type GitCommands,
  type WorkspaceInput
} from './workspace-identity'
import {
  EXPORT_FORMAT_VERSION,
  type ExportResult,
  type SnapshotManifest,
  type WorkspaceIdentity
} from './snapshot-types'

const DOMAIN_FILE_ORDER: ReadonlyArray<keyof SnapshotDump> = [
  'projects',
  'workspaces',
  'tasks',
  'conversations',
  'inbox',
  'sessions',
  'knowledge'
]

const MANIFEST_FILE = 'manifest.json'

export interface ExportOptions {
  outDir: string
  appVersion: string
  db: Database.Database
  /** Project IDs to include. Defaults to all projects in the DB. */
  projectIds?: string[]
  /** Git command source — injected for tests. */
  git?: GitCommands
  /** Override exportedAt timestamp — for deterministic tests. */
  now?: () => string
}

export function runExport(opts: ExportOptions): ExportResult {
  const { outDir, appVersion, db } = opts
  const git = opts.git ?? realGitCommands()
  const now = opts.now ?? (() => new Date().toISOString())

  fs.mkdirSync(outDir, { recursive: true })

  const projectIds = opts.projectIds ?? listAllProjectIds(db)
  const dump = dumpProjectsScope(db, projectIds)

  const workspaceInputs: WorkspaceInput[] = dump.workspaces.rows.map((row) => ({
    id: String(row.id),
    cwd: String(row.cwd)
  }))
  const projectIdByWorkspaceId = new Map<string, string>()
  for (const row of dump.workspaces.rows) {
    projectIdByWorkspaceId.set(String(row.id), String(row.project_id))
  }

  const identities = computeWorkspaceIdentities(
    workspaceInputs,
    (w) => projectIdByWorkspaceId.get(w.id) ?? '',
    git
  )

  // Serialize each domain file deterministically. The same string is hashed
  // and (later) written to disk — guaranteeing the on-disk hash never drifts.
  const domainBytes = new Map<keyof SnapshotDump, string>()
  for (const key of DOMAIN_FILE_ORDER) {
    domainBytes.set(key, canonicalJson(dump[key]))
  }
  const identitiesBytes = canonicalJson(sortIdentities(identities))

  const contentHash = computeContentHash(domainBytes, identitiesBytes)

  // Check existing manifest for no-op skip / metadata-refresh decision.
  const existingManifest = readExistingManifest(outDir)
  if (existingManifest && existingManifest.contentHash === contentHash) {
    if (existingManifest.appVersion === appVersion) {
      return {
        status: 'no-op',
        outDir,
        contentHash,
        manifestPath: path.join(outDir, MANIFEST_FILE),
        filesWritten: []
      }
    }
    // appVersion drift on identical content — refresh manifest only.
    const manifest: SnapshotManifest = {
      exportFormatVersion: EXPORT_FORMAT_VERSION,
      appVersion,
      exportedAt: now(),
      contentHash,
      projectIds: [...projectIds].sort(),
      workspaceIdentities: sortIdentities(identities),
      includesArtifacts: false
    }
    const manifestPath = writeFileAtomic(outDir, MANIFEST_FILE, canonicalJson(manifest))
    return {
      status: 'metadata-refresh',
      outDir,
      contentHash,
      manifestPath,
      filesWritten: [MANIFEST_FILE]
    }
  }

  // Full write — domain files first, manifest LAST so a partial export is
  // detectable (no manifest = readers treat the directory as invalid).
  const filesWritten: string[] = []
  for (const key of DOMAIN_FILE_ORDER) {
    const fileName = `${key}.json`
    writeFileAtomic(outDir, fileName, domainBytes.get(key)!)
    filesWritten.push(fileName)
  }

  const manifest: SnapshotManifest = {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    appVersion,
    exportedAt: now(),
    contentHash,
    projectIds: [...projectIds].sort(),
    workspaceIdentities: sortIdentities(identities),
    includesArtifacts: false
  }
  const manifestPath = writeFileAtomic(outDir, MANIFEST_FILE, canonicalJson(manifest))
  filesWritten.push(MANIFEST_FILE)

  return { status: 'written', outDir, contentHash, manifestPath, filesWritten }
}

function listAllProjectIds(db: Database.Database): string[] {
  const rows = db.prepare('SELECT id FROM projects ORDER BY id').all() as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function readExistingManifest(outDir: string): SnapshotManifest | null {
  const file = path.join(outDir, MANIFEST_FILE)
  if (!fs.existsSync(file)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotManifest
    if (typeof parsed.contentHash !== 'string' || typeof parsed.appVersion !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function computeContentHash(
  domainBytes: Map<keyof SnapshotDump, string>,
  identitiesBytes: string
): string {
  const hash = createHash('sha256')
  for (const key of DOMAIN_FILE_ORDER) {
    hash.update(domainBytes.get(key)!, 'utf8')
  }
  hash.update(identitiesBytes, 'utf8')
  return hash.digest('hex')
}

function sortIdentities(identities: WorkspaceIdentity[]): WorkspaceIdentity[] {
  return [...identities].sort((a, b) => {
    if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1
    return a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0
  })
}

function writeFileAtomic(outDir: string, fileName: string, content: string): string {
  const finalPath = path.join(outDir, fileName)
  const tmpPath = finalPath + '.tmp'
  fs.writeFileSync(tmpPath, content, 'utf8')
  fs.renameSync(tmpPath, finalPath)
  return finalPath
}
