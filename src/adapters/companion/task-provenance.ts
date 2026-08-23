// TASK-1748 — the three questions you currently answer by opening a terminal:
// which ADR decided this, which files it changed, and at which commit. All three
// are already in the database; none of them is reachable from a single graph
// read, which is why this module exists rather than a `graph_edges` call.
//
//   files   ← task_code_refs, resolved against the owning workspace's cwd so a
//             ref pointing at a deleted file is reported as deleted, not linked
//   commits ← SessionHandoff.commits, tagged with the session's workspaceId,
//             because the stored string is "<sha> <subject>" with no repo in it
//   adrs    ← parsed out of knowledge bodies. Only 1 of 39 ADRs carries
//             realizesTasks in frontmatter while 38 mention TASK-xxx in prose,
//             so reading the structured field alone finds almost nothing.
//
// Read-only throughout. This is NOT a code-graph: ADR-033 retired the AST graph
// deliberately and nothing here rebuilds it — every fact is one the session
// lifecycle already recorded.

import path from 'path'
import fs from 'fs'
import type { CodeRefOperations } from '../../core/domain/interfaces/code-ref-operations.interface'
import type { KnowledgeOperations } from '../../core/domain/interfaces/knowledge-operations.interface'
import type { SessionOperations } from '../../core/domain/interfaces/session-repository.interface'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'
import type { TouchesRelation } from '../../core/domain/code-ref-types'

export interface ProvenanceFile {
  path: string
  workspaceId: string | null
  relation: TouchesRelation
  /**
   * False when the path no longer resolves under its workspace's cwd. 6 of the
   * companion workspace's 9 code_refs point at files deleted since — rendering
   * those as live links would be a confident lie, so the flag travels with the
   * row rather than being recomputed in the view.
   */
  exists: boolean
}

export interface ProvenanceCommit {
  /** "<short-sha> <subject>" exactly as the handoff stored it. */
  raw: string
  sha: string
  subject: string
  /** Which repo the sha lives in — from the session, never guessed. */
  workspaceId: string | null
  sessionId: string
}

export interface ProvenanceAdr {
  slug: string
  title: string
  /** 'frontmatter' when realizesTasks named the task, 'body' when prose did. */
  via: 'frontmatter' | 'body'
}

export type FilesConfidence = 'known' | 'undeterminable'

export interface TaskProvenance {
  files: ProvenanceFile[]
  commits: ProvenanceCommit[]
  adrs: ProvenanceAdr[]
  /**
   * TASK-1751's distinction, applied at read time: commits with zero TOUCHES
   * means the edit path bypassed the file_modified hook, not that nothing
   * changed. A task with neither commits nor TOUCHES really did change no
   * files and stays 'known'.
   */
  filesConfidence: FilesConfidence
}

export interface ProvenanceDeps
  extends CodeRefOperations,
    KnowledgeOperations,
    SessionOperations,
    WorkspaceOperations {}

/**
 * Match TASK-123 as a whole token. Bare `\d+` would let TASK-1597 satisfy a
 * lookup for TASK-159, which is the failure that makes a reverse index useless.
 */
function mentionsTask(body: string, taskId: string): boolean {
  return new RegExp(`\\b${taskId}\\b`).test(body)
}

/** "a6ec575 feat(web): thing" -> sha + subject. Subject may be empty. */
function splitCommit(raw: string): { sha: string; subject: string } {
  const trimmed = raw.trim()
  const gap = trimmed.indexOf(' ')
  if (gap === -1) return { sha: trimmed, subject: '' }
  return { sha: trimmed.slice(0, gap), subject: trimmed.slice(gap + 1) }
}

/**
 * Does `relPath` exist inside `cwd`? A ref whose workspace is unknown or whose
 * cwd is gone is reported as not existing rather than as existing — the honest
 * direction, since the view suppresses the link either way.
 */
function fileExists(cwd: string | undefined, relPath: string): boolean {
  if (!cwd) return false
  try {
    return fs.existsSync(path.resolve(cwd, relPath))
  } catch {
    return false
  }
}

async function collectFiles(
  svc: ProvenanceDeps,
  taskId: string,
  cwdFor: (workspaceId: string | null) => Promise<string | undefined>
): Promise<ProvenanceFile[]> {
  const edges = await svc.getTouchesForTask(taskId)
  const files: ProvenanceFile[] = []
  for (const edge of edges) {
    const ref = await svc.getCodeRef(edge.codeRefSlug)
    if (!ref) continue
    files.push({
      path: ref.path,
      workspaceId: ref.workspaceId,
      relation: edge.relation,
      exists: fileExists(await cwdFor(ref.workspaceId), ref.path)
    })
  }
  return files
}

async function collectCommits(
  svc: ProvenanceDeps,
  projectId: string,
  taskId: string
): Promise<ProvenanceCommit[]> {
  const sessions = await svc.findSessions(projectId)
  const commits: ProvenanceCommit[] = []
  for (const session of sessions) {
    if (session.taskId !== taskId) continue
    for (const raw of session.handoff?.commits ?? []) {
      const { sha, subject } = splitCommit(raw)
      commits.push({ raw, sha, subject, workspaceId: session.workspaceId, sessionId: session.id })
    }
  }
  return commits
}

async function collectAdrs(
  svc: ProvenanceDeps,
  projectId: string,
  taskId: string
): Promise<ProvenanceAdr[]> {
  // Scoped to the task's own project. Unscoped, this walks every project's
  // decisions — including entries whose files live in other repositories, which
  // is both wrong (another project's ADR is not this task's provenance) and the
  // reason a single unreadable file could reach this loop at all.
  const decisions = await svc.listKnowledge({ type: 'decision', projectId })
  const adrs: ProvenanceAdr[] = []
  for (const item of decisions) {
    // Reading an entry parses its frontmatter, which THROWS on a malformed
    // refs block. One bad file must not sink the whole task read: provenance
    // is supplementary, and losing the task entirely to learn nothing about
    // one ADR is the worst of both. Skip it and keep going.
    let entry: Awaited<ReturnType<typeof svc.getKnowledge>> = null
    try {
      entry = await svc.getKnowledge(item.slug)
    } catch {
      continue
    }
    if (!entry) continue
    const realizes = entry.frontmatter.structured?.realizesTasks ?? []
    if (realizes.includes(taskId)) {
      adrs.push({ slug: item.slug, title: item.title, via: 'frontmatter' })
      continue
    }
    // The load-bearing half: 38 of 39 ADRs name their tasks only in prose.
    if (mentionsTask(entry.body, taskId)) {
      adrs.push({ slug: item.slug, title: item.title, via: 'body' })
    }
  }
  return adrs
}

export async function buildTaskProvenance(
  svc: ProvenanceDeps,
  projectId: string,
  taskId: string
): Promise<TaskProvenance> {
  const cwdCache = new Map<string, string | undefined>()
  const cwdFor = async (workspaceId: string | null): Promise<string | undefined> => {
    if (!workspaceId) return undefined
    if (!cwdCache.has(workspaceId)) {
      const ws = await svc.getWorkspace(workspaceId)
      cwdCache.set(workspaceId, ws?.cwd ?? undefined)
    }
    return cwdCache.get(workspaceId)
  }

  // Each section degrades on its own. Provenance is supplementary to the task,
  // so a failure in one collector must cost that section and nothing more —
  // returning 500 for the whole task read because one ADR file is unreadable
  // is a worse answer than an incomplete but honest one.
  const [files, commits, adrs] = await Promise.all([
    collectFiles(svc, taskId, cwdFor).catch(() => [] as ProvenanceFile[]),
    collectCommits(svc, projectId, taskId).catch(() => [] as ProvenanceCommit[]),
    collectAdrs(svc, projectId, taskId).catch(() => [] as ProvenanceAdr[])
  ])

  return {
    files,
    commits,
    adrs,
    filesConfidence: commits.length > 0 && files.length === 0 ? 'undeterminable' : 'known'
  }
}
