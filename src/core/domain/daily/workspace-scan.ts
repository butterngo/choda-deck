import { execFile } from 'child_process'
import * as fs from 'fs'
import { splitLines } from '../../utils/lines'

// TASK-2671 — the git half of the daily report's Outstanding block (TASK-2669):
// per repo, uncommitted files, local branches not merged into the default
// branch, and open PRs.
//
// The rule that shapes everything here is the one workspace-commits.ts already
// keeps: a git failure is a failure, never an empty result. A repo that could not
// be read is `failed` with its counts null — never 0 and never [] — so the report
// can name it instead of calling it clean. Same for a folder that is gone
// (`missing`) and a cwd that is not inside a repository (`not-a-repo`).
//
// Two workspaces can sit in one repository (tms FE at C:/dev/test/tms/fe lives
// inside BE's C:/dev/test/tms), so repos are keyed by `--show-toplevel` and
// scanned once.

export type RepoScanState = 'ok' | 'missing' | 'not-a-repo' | 'failed'

export interface ScanWorkspaceInput {
  id: string
  projectId: string
  cwd: string
}

export interface OpenPr {
  number: number
  title: string
  headRefName: string
  url: string
}

export interface RepoScan {
  /** null when the workspace never reached a repository (missing, not-a-repo, failed before rev-parse). */
  toplevel: string | null
  workspaceIds: string[]
  projectIds: string[]
  state: RepoScanState
  reason?: string
  defaultBranch?: string
  /** null whenever it could not be measured — never 0 by default. */
  dirtyFiles: number | null
  unmergedBranches: string[] | null
  prs: 'ok' | 'unknown'
  openPrs: OpenPr[]
}

/** Runs one command. Rejects on a non-zero exit; `stderr` on the error when the process wrote any. */
export type Exec = (cmd: string, args: string[], cwd: string) => Promise<string>

export interface ScanOptions {
  timeoutMs?: number
  concurrency?: number
  /** false skips the PR lookup; every repo then reports prs 'unknown'. */
  gh?: boolean
  exec?: Exec
}

export const DEFAULT_SCAN_TIMEOUT_MS = 10_000
export const DEFAULT_SCAN_CONCURRENCY = 8

class ScanTimeout extends Error {
  constructor() {
    super('timeout')
  }
}

const defaultExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr }))
        return
      }
      resolve(stdout)
    })
  })

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ScanTimeout()), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

function reasonOf(err: unknown): string {
  if (err instanceof ScanTimeout) return 'timeout'
  const stderr = (err as { stderr?: string })?.stderr
  const msg = (stderr && stderr.trim()) || (err as Error)?.message || String(err)
  return splitLines(msg)[0]?.trim() || 'git failed'
}

function keyOf(toplevel: string): string {
  return toplevel.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

function unscanned(ws: ScanWorkspaceInput, state: RepoScanState, reason?: string): RepoScan {
  return {
    toplevel: null,
    workspaceIds: [ws.id],
    projectIds: [ws.projectId],
    state,
    ...(reason ? { reason } : {}),
    dirtyFiles: null,
    unmergedBranches: null,
    prs: 'unknown',
    openPrs: []
  }
}

/** Scan every workspace's repository once. Archived workspaces are filtered out by the caller. */
export async function scanWorkspaces(
  workspaces: ScanWorkspaceInput[],
  opts: ScanOptions = {}
): Promise<RepoScan[]> {
  const exec = opts.exec ?? defaultExec
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS
  const concurrency = opts.concurrency ?? DEFAULT_SCAN_CONCURRENCY
  const run = (cmd: string, args: string[], cwd: string): Promise<string> =>
    withTimeout(exec(cmd, args, cwd), timeoutMs)
  const git = (cwd: string, args: string[]): Promise<string> => run('git', args, cwd)

  // 1. Resolve each workspace to its repository (or to why it has none).
  type Resolved = { ws: ScanWorkspaceInput; toplevel?: string; result?: RepoScan }
  const resolved = await pool(workspaces, concurrency, async (ws): Promise<Resolved> => {
    if (!fs.existsSync(ws.cwd)) return { ws, result: unscanned(ws, 'missing') }
    try {
      const top = (await git(ws.cwd, ['rev-parse', '--show-toplevel'])).trim()
      return { ws, toplevel: top }
    } catch (err) {
      const reason = reasonOf(err)
      if (/not a git repository/i.test(reason)) return { ws, result: unscanned(ws, 'not-a-repo') }
      return { ws, result: unscanned(ws, 'failed', reason) }
    }
  })

  // 2. One entry per repository, every workspace that resolves to it listed on it.
  const repos = new Map<
    string,
    { toplevel: string; workspaceIds: string[]; projectIds: string[] }
  >()
  const results: RepoScan[] = []
  for (const r of resolved) {
    if (r.result) {
      results.push(r.result)
      continue
    }
    const key = keyOf(r.toplevel!)
    const repo = repos.get(key) ?? { toplevel: r.toplevel!, workspaceIds: [], projectIds: [] }
    repo.workspaceIds.push(r.ws.id)
    if (!repo.projectIds.includes(r.ws.projectId)) repo.projectIds.push(r.ws.projectId)
    repos.set(key, repo)
  }

  // 3. Scan each repository.
  const scanned = await pool([...repos.values()], concurrency, async (repo): Promise<RepoScan> => {
    const base = {
      toplevel: repo.toplevel,
      workspaceIds: repo.workspaceIds,
      projectIds: repo.projectIds
    }
    let defaultBranch: string
    let compareRef: string
    let dirtyFiles: number
    let unmergedBranches: string[]
    try {
      const resolvedDefault = await resolveDefault(repo.toplevel, git)
      if (!resolvedDefault) {
        return {
          ...base,
          state: 'failed',
          reason: 'no-default-branch',
          dirtyFiles: null,
          unmergedBranches: null,
          prs: 'unknown',
          openPrs: []
        }
      }
      ;({ defaultBranch, compareRef } = resolvedDefault)
      dirtyFiles = splitLines(await git(repo.toplevel, ['status', '--porcelain'])).filter(
        (l) => l.length > 0
      ).length
      unmergedBranches = splitLines(
        await git(repo.toplevel, ['branch', '--no-merged', compareRef, '--format=%(refname:short)'])
      )
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch (err) {
      return {
        ...base,
        state: 'failed',
        reason: reasonOf(err),
        dirtyFiles: null,
        unmergedBranches: null,
        prs: 'unknown',
        openPrs: []
      }
    }

    let prs: RepoScan['prs'] = 'unknown'
    let openPrs: OpenPr[] = []
    if (opts.gh !== false) {
      try {
        const out = await run(
          'gh',
          ['pr', 'list', '--state', 'open', '--json', 'number,title,headRefName,url'],
          repo.toplevel
        )
        openPrs = JSON.parse(out) as OpenPr[]
        prs = 'ok'
      } catch {
        prs = 'unknown'
        openPrs = []
      }
    }

    return { ...base, state: 'ok', defaultBranch, dirtyFiles, unmergedBranches, prs, openPrs }
  })

  return [...results, ...scanned]
}

/**
 * The default branch, from origin/HEAD; without one, whichever of main/master
 * exists locally. `compareRef` is what unmerged branches are measured against.
 */
async function resolveDefault(
  toplevel: string,
  git: (cwd: string, args: string[]) => Promise<string>
): Promise<{ defaultBranch: string; compareRef: string } | null> {
  try {
    const ref = (
      await git(toplevel, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    ).trim()
    if (ref) return { defaultBranch: ref.replace(/^origin\//, ''), compareRef: ref }
  } catch (err) {
    if (err instanceof ScanTimeout) throw err
  }
  for (const name of ['main', 'master']) {
    try {
      await git(toplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
      return { defaultBranch: name, compareRef: name }
    } catch (err) {
      if (err instanceof ScanTimeout) throw err
    }
  }
  return null
}
