import * as fs from 'fs'
import * as path from 'path'
import type Database from 'better-sqlite3'

import {
  EXPORT_FORMAT_VERSION,
  SNAPSHOT_FILES,
  type SnapshotManifest,
  type WorkspaceIdentity
} from './snapshot-types'
import { identityKey, type PathsMapping } from './paths-mapping'

export const MAX_IDS_PER_TABLE = 20

export interface TableDeletePlan {
  /** Domain table whose rows will be deleted on import. */
  table: string
  /** Total number of rows that will be removed. */
  totalCount: number
  /** First MAX_IDS_PER_TABLE row IDs (sorted) — for human-readable confirm. */
  sampleIds: string[]
}

export interface KnowledgeMissingFile {
  slug: string
  filePath: string
  /** Resolved absolute path that was checked. */
  resolvedPath: string
  /** workspace identity key the file was resolved against (null if project-level). */
  workspaceKey: string | null
}

export interface PreflightReport {
  ok: boolean
  errors: string[]
  warnings: string[]
  manifest: SnapshotManifest | null
  /** Workspaces declared in the manifest with no local cwd in paths.local.json. */
  missingMappings: WorkspaceIdentity[]
  /** Per-table summary of rows that will be removed on import. */
  deletePlan: TableDeletePlan[]
  /** Knowledge entries whose `file_path` is not present locally. */
  knowledgeMissing: KnowledgeMissingFile[]
}

export interface PreflightOptions {
  snapshotDir: string
  db: Database.Database
  pathsMapping: PathsMapping
  /** When true, missing path mappings become a hard error (no interactive prompt). */
  yes: boolean
}

export function runPreflight(opts: PreflightOptions): PreflightReport {
  const errors: string[] = []
  const warnings: string[] = []

  const manifestPath = path.join(opts.snapshotDir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    errors.push(`manifest.json not found in ${opts.snapshotDir}`)
    return emptyReport(errors, warnings)
  }

  let manifest: SnapshotManifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SnapshotManifest
  } catch (err) {
    errors.push(`manifest.json is not valid JSON: ${(err as Error).message}`)
    return emptyReport(errors, warnings)
  }

  if (manifest.exportFormatVersion !== EXPORT_FORMAT_VERSION) {
    errors.push(
      `unsupported exportFormatVersion ${manifest.exportFormatVersion} ` +
        `(this build expects ${EXPORT_FORMAT_VERSION})`
    )
  }

  for (const file of SNAPSHOT_FILES) {
    if (!fs.existsSync(path.join(opts.snapshotDir, file))) {
      errors.push(`missing snapshot file: ${file}`)
    }
  }
  if (errors.length > 0) {
    return { ...emptyReport(errors, warnings), manifest }
  }

  const incoming = loadDomainFiles(opts.snapshotDir)

  const missingMappings = collectMissingMappings(manifest.workspaceIdentities, opts.pathsMapping)
  if (missingMappings.length > 0) {
    if (opts.yes) {
      errors.push(
        `missing local path mapping for ${missingMappings.length} workspace(s); ` +
          `--yes disables interactive prompting — re-run without --yes to register them`
      )
    } else {
      warnings.push(
        `missing local path mapping for ${missingMappings.length} workspace(s) — ` +
          `they will be prompted before import`
      )
    }
  }

  const deletePlan = computeDeletePlan(opts.db, manifest.projectIds, incoming)
  const knowledgeMissing = collectKnowledgeMissing(
    incoming,
    manifest.workspaceIdentities,
    opts.pathsMapping
  )
  if (knowledgeMissing.length > 0) {
    warnings.push(
      `${knowledgeMissing.length} knowledge entries reference files not present locally — ` +
        `pull the project repo on this machine to resolve`
    )
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    manifest,
    missingMappings,
    deletePlan,
    knowledgeMissing
  }
}

interface IncomingDomain {
  projects: { rows: Row[] }
  workspaces: { rows: Row[] }
  tasks: { rows: Row[]; tags?: Row[]; relationships?: Row[] }
  conversations: {
    rows: Row[]
    messages?: Row[]
    actions?: Row[]
    links?: Row[]
    participants?: Row[]
  }
  inbox: { rows: Row[] }
  sessions: { rows: Row[] }
  knowledge: { rows: Row[] }
}

type Row = Record<string, unknown>

function loadDomainFiles(snapshotDir: string): IncomingDomain {
  const read = (name: string): { rows: Row[] } => {
    const raw = fs.readFileSync(path.join(snapshotDir, name), 'utf8')
    return JSON.parse(raw) as { rows: Row[] }
  }
  return {
    projects: read('projects.json'),
    workspaces: read('workspaces.json'),
    tasks: read('tasks.json') as IncomingDomain['tasks'],
    conversations: read('conversations.json') as IncomingDomain['conversations'],
    inbox: read('inbox.json'),
    sessions: read('sessions.json'),
    knowledge: read('knowledge.json')
  }
}

function emptyReport(errors: string[], warnings: string[]): PreflightReport {
  return {
    ok: false,
    errors,
    warnings,
    manifest: null,
    missingMappings: [],
    deletePlan: [],
    knowledgeMissing: []
  }
}

function collectMissingMappings(
  identities: WorkspaceIdentity[],
  mapping: PathsMapping
): WorkspaceIdentity[] {
  const missing: WorkspaceIdentity[] = []
  for (const id of identities) {
    if (id.canonicalGitRemote === null) continue
    const key = identityKey(id)
    if (!mapping.mappings[key]) missing.push(id)
  }
  return missing
}

const PROJECT_SCOPED_TABLES: ReadonlyArray<{
  table: string
  domainKey: keyof IncomingDomain
  projectColumn: string
  idColumn: string
}> = [
  { table: 'tasks', domainKey: 'tasks', projectColumn: 'project_id', idColumn: 'id' },
  {
    table: 'conversations',
    domainKey: 'conversations',
    projectColumn: 'project_id',
    idColumn: 'id'
  },
  { table: 'inbox_items', domainKey: 'inbox', projectColumn: 'project_id', idColumn: 'id' },
  { table: 'sessions', domainKey: 'sessions', projectColumn: 'project_id', idColumn: 'id' },
  {
    table: 'knowledge_index',
    domainKey: 'knowledge',
    projectColumn: 'project_id',
    idColumn: 'slug'
  }
]

function computeDeletePlan(
  db: Database.Database,
  projectIds: string[],
  incoming: IncomingDomain
): TableDeletePlan[] {
  const out: TableDeletePlan[] = []
  if (projectIds.length === 0) return out

  for (const cfg of PROJECT_SCOPED_TABLES) {
    const incomingIds = collectIncomingIds(incoming, cfg.domainKey, projectIds, cfg.idColumn)
    const liveIds = selectLiveIds(db, cfg.table, cfg.projectColumn, cfg.idColumn, projectIds)
    const toDelete: string[] = []
    for (const id of liveIds) if (!incomingIds.has(id)) toDelete.push(id)
    if (toDelete.length === 0) continue
    toDelete.sort()
    out.push({
      table: cfg.table,
      totalCount: toDelete.length,
      sampleIds: toDelete.slice(0, MAX_IDS_PER_TABLE)
    })
  }
  return out
}

function collectIncomingIds(
  incoming: IncomingDomain,
  domainKey: keyof IncomingDomain,
  projectIds: string[],
  idColumn: string
): Set<string> {
  const projectSet = new Set(projectIds)
  const ids = new Set<string>()
  const file = incoming[domainKey] as { rows: Row[] }
  for (const row of file.rows) {
    if (!projectSet.has(String(row.project_id))) continue
    ids.add(String(row[idColumn]))
  }
  return ids
}

function selectLiveIds(
  db: Database.Database,
  table: string,
  projectColumn: string,
  idColumn: string,
  projectIds: string[]
): string[] {
  const placeholders = projectIds.map(() => '?').join(',')
  const sql = `SELECT ${idColumn} AS id FROM ${table} WHERE ${projectColumn} IN (${placeholders})`
  const rows = db.prepare(sql).all(...projectIds) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

function collectKnowledgeMissing(
  incoming: IncomingDomain,
  identities: WorkspaceIdentity[],
  mapping: PathsMapping
): KnowledgeMissingFile[] {
  const out: KnowledgeMissingFile[] = []
  const identityByWorkspace = new Map<string, WorkspaceIdentity>()
  for (const id of identities) identityByWorkspace.set(id.workspaceId, id)

  for (const row of incoming.knowledge.rows) {
    const slug = String(row.slug)
    const filePath = String(row.file_path)
    const workspaceId = row.workspace_id ? String(row.workspace_id) : null
    const identity = workspaceId ? identityByWorkspace.get(workspaceId) ?? null : null
    const baseDir = identity && identity.canonicalGitRemote ? mapping.mappings[identityKey(identity)] : null
    if (!baseDir) {
      // No mapping → cannot verify. Skip silently; missingMappings already
      // surfaces this gap.
      continue
    }
    const resolvedPath = path.resolve(baseDir, filePath)
    if (!fs.existsSync(resolvedPath)) {
      out.push({
        slug,
        filePath,
        resolvedPath,
        workspaceKey: identity ? identityKey(identity) : null
      })
    }
  }
  return out
}

/**
 * Format the delete plan + knowledge gaps for human-readable output.
 * Caps each table list at MAX_IDS_PER_TABLE with `... (N more)` suffix.
 */
export function formatPreflightSummary(report: PreflightReport): string {
  const lines: string[] = []
  if (report.errors.length > 0) {
    lines.push('Errors:')
    for (const e of report.errors) lines.push(`  - ${e}`)
  }
  if (report.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of report.warnings) lines.push(`  - ${w}`)
  }

  if (report.deletePlan.length === 0) {
    lines.push('Delete diff: no rows will be removed (target has no project-scoped rows that the snapshot omits).')
  } else {
    lines.push('Delete diff (rows present locally but absent from incoming snapshot):')
    for (const d of report.deletePlan) {
      const overflow = d.totalCount - d.sampleIds.length
      const suffix = overflow > 0 ? `, ... (${overflow} more)` : ''
      lines.push(`  - ${d.table}: ${d.totalCount} (${d.sampleIds.join(', ')}${suffix})`)
    }
  }

  if (report.missingMappings.length > 0) {
    lines.push('Missing path mappings:')
    for (const m of report.missingMappings) {
      lines.push(`  - ${identityKey(m)} (workspace=${m.workspaceId}, project=${m.projectId})`)
    }
  }

  if (report.knowledgeMissing.length > 0) {
    lines.push('Knowledge entries with missing files:')
    for (const k of report.knowledgeMissing.slice(0, MAX_IDS_PER_TABLE)) {
      lines.push(`  - ${k.slug} → ${k.resolvedPath}`)
    }
    const overflow = report.knowledgeMissing.length - MAX_IDS_PER_TABLE
    if (overflow > 0) lines.push(`  ... (${overflow} more)`)
  }

  return lines.join('\n')
}
