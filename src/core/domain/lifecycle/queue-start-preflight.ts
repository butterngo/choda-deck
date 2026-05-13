import * as path from 'node:path'
import type { Task } from '../task-types'
import { AUTO_SAFE_LABEL, validateAutoSafeTask } from '../auto-safe-validator'
import { extractFilePointersSection, parseFilePointers } from '../../executor/prewarm-compose'

/**
 * Pre-flight validator for `choda-deck queue start` per ADR-019 Phase 3.
 *
 * Verifies every task in the batch CAN run before any spawn happens, so a single
 * bad task aborts the whole batch (default) rather than wasting tokens on a
 * partial run. Caller injects all git/fs/gh ops to keep this module pure.
 */

export interface PreflightTaskFailure {
  taskId: string
  reasons: string[]
}

export interface PreflightGitFns {
  /** True iff the path exists on disk. */
  pathExists(p: string): Promise<boolean>
  /** True iff the directory is writable. Assumes the dir exists. */
  isWritable(dirPath: string): Promise<boolean>
  /** Resolve a git ref (branch/tag/sha-ish) in repoCwd to a full SHA, or null if unresolvable. */
  resolveRef(repoCwd: string, ref: string): Promise<string | null>
  /** True iff a local branch with this exact name exists in repoCwd. */
  branchExists(repoCwd: string, branch: string): Promise<boolean>
  /** True iff `gh auth status` exits 0. */
  ghAuthStatus(): Promise<boolean>
  /** True iff a tracked file at relPath exists in the working tree at the given SHA. */
  fileExistsAtSha(repoCwd: string, sha: string, relPath: string): Promise<boolean>
}

export interface PreflightInput {
  tasks: Task[]
  repoCwd: string
  baseRef: string
  /** Where per-task worktrees will be added — e.g. `C:\\dev\\choda-deck.worktrees`. */
  worktreesParentDir: string
  /** Branch prefix per task — final branch is `${branchPrefix}${task.id}`. Default `auto/`. */
  branchPrefix: string
  fns: PreflightGitFns
}

export interface PreflightResult {
  ok: boolean
  /** Captured once when baseRef resolves — passed to git worktree add to freeze the base. */
  baseSha: string | null
  failures: PreflightTaskFailure[]
  globalErrors: string[]
}

export async function validateQueueStartPreflight(input: PreflightInput): Promise<PreflightResult> {
  const { tasks, repoCwd, baseRef, worktreesParentDir, branchPrefix, fns } = input

  const globalErrors: string[] = []

  const [baseSha, parentExists, ghOk] = await Promise.all([
    fns.resolveRef(repoCwd, baseRef),
    fns.pathExists(worktreesParentDir),
    fns.ghAuthStatus()
  ])

  if (baseSha === null) {
    globalErrors.push(`baseRef "${baseRef}" is unresolvable in ${repoCwd}`)
  }
  if (!parentExists) {
    globalErrors.push(`worktrees parent dir does not exist: ${worktreesParentDir}`)
  } else {
    const writable = await fns.isWritable(worktreesParentDir)
    if (!writable) {
      globalErrors.push(`worktrees parent dir is not writable: ${worktreesParentDir}`)
    }
  }
  if (!ghOk) {
    globalErrors.push('gh auth status failed — `gh` is not authenticated (queue start ends with PR create)')
  }

  const failures: PreflightTaskFailure[] = []
  for (const task of tasks) {
    const reasons = await validateTask(task, repoCwd, baseSha, worktreesParentDir, branchPrefix, fns)
    if (reasons.length > 0) {
      failures.push({ taskId: task.id, reasons })
    }
  }

  return {
    ok: globalErrors.length === 0 && failures.length === 0,
    baseSha,
    failures,
    globalErrors
  }
}

async function validateTask(
  task: Task,
  repoCwd: string,
  baseSha: string | null,
  worktreesParentDir: string,
  branchPrefix: string,
  fns: PreflightGitFns
): Promise<string[]> {
  const reasons: string[] = []

  if (!task.labels.includes(AUTO_SAFE_LABEL)) {
    reasons.push(`missing label "${AUTO_SAFE_LABEL}"`)
  }

  const structural = validateAutoSafeTask(task)
  if (!structural.valid) {
    for (const err of structural.errors) {
      reasons.push(`structural: ${err}`)
    }
  }

  const worktreePath = path.join(worktreesParentDir, task.id)
  const branchName = `${branchPrefix}${task.id}`
  const [worktreeExists, branchAlreadyThere] = await Promise.all([
    fns.pathExists(worktreePath),
    fns.branchExists(repoCwd, branchName)
  ])
  if (worktreeExists) {
    reasons.push(`worktree path already exists: ${worktreePath} (run cleanup_worktree_orphans first)`)
  }
  if (branchAlreadyThere) {
    reasons.push(`branch already exists: ${branchName}`)
  }

  // File Pointer existence at baseSha — only meaningful when baseSha was resolved.
  // Pointers without explicit range are accepted (new-file convention per prewarm L1).
  if (baseSha !== null && structural.valid) {
    const section = extractFilePointersSection(task.body ?? '')
    if (section !== null) {
      const pointers = parseFilePointers(section)
      for (const pointer of pointers) {
        if (pointer.startLine === undefined) continue
        const exists = await fns.fileExistsAtSha(repoCwd, baseSha, pointer.filePath)
        if (!exists) {
          reasons.push(`File Pointer with range references missing file at baseSha: ${pointer.filePath}`)
        }
      }
    }
  }

  return reasons
}
