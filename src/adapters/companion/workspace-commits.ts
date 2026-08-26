// TASK-1779 — a workspace's git history as a read surface, so the companion can
// stand at a commit and look back at the task and the ADRs behind it.
//
// Two things here are deliberate and easy to "simplify" into bugs:
//
//   1. A git failure is a 409, never `200 + []`. GitOps.commitsInWindow ends in
//      `catch { return [] }` (knowledge-git.ts:68-71) and that is correct for
//      closing a session — a missing repo must not break session_end. It is
//      wrong here: an empty list reads as "this repo has no commits", which is a
//      confident false statement rather than an absence. Same family as
//      filesConfidence:'undeterminable' in task-provenance.ts.
//
//   2. `sha` is validated against a hex pattern before it reaches git. Every
//      other field on these routes is a workspace id resolved through the
//      service, but sha is passed to `git` as an argument, and git treats a
//      leading `-` as an option. `--upload-pack=…` in a path segment is a real
//      shape of attack; the pattern check is the guard, not decoration.
//
// Field separator is \x1f (unit separator) rather than a space: commit subjects
// contain spaces, colons and pipes routinely, and every naive delimiter here has
// a subject in the real log that breaks it.

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'
import { parseUnifiedDiff, type Hunks } from './commit-diff'

const ROUTE_PREFIX = '/workspaces/'
const COMMITS_SEGMENT = '/commits'

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

/** Unit separator — see the note at the top of this file. */
const SEP = '\x1f'

const LOG_FORMAT = ['%H', '%h', '%aI', '%s'].join(SEP)
const SHOW_FORMAT = ['%H', '%h', '%aI', '%s', '%b'].join(SEP)

/** A sha as it may appear in a URL. Anything else never reaches `git`. */
// Built with RegExp rather than written as literals: this file is edited by
// tooling that has silently turned a backslash escape into a control character
// before (a regex  became 0x08, and it typechecked). A string source has no
// escape to lose.
const LINE_BREAK = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10))
const LEADING_MARKER = new RegExp('^[*+]?[ ' + String.fromCharCode(9) + ']*')

const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/

export interface CommitRow {
  /** Full 40-char sha. */
  sha: string
  /** Abbreviated sha, as git chose to abbreviate it. */
  shortSha: string
  /** Author date, ISO 8601 with offset. */
  authorDate: string
  subject: string
  /** Every TASK-id in the subject, in order, deduped. Empty is a fact. */
  taskIds: string[]
}

export interface CommitFileStat {
  path: string
  /**
   * TASK-1791 — the changed lines, present only when `patch=1` was asked for.
   *
   * `null` (not `[]`) means the patch was NOT produced: the file is binary, or
   * it exceeded the per-file cap. An empty array would say the file changed
   * nothing, which is a different and wrong claim — same rule as
   * filesConfidence:'undeterminable'.
   */
  hunks?: Hunks
  /** Why hunks is null, when it is. */
  omitted?: 'binary' | 'too-large'
  /** Set only on a rename, so a reader can see where the file came from. */
  oldPath?: string
  /** null for a binary file — git reports `-`, and 0 would be a lie. */
  insertions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * TASK-1784 — how attached a commit is to this repository's refs.
 *
 * `cat-file -e` answers "is this object in the database", which is NOT the same
 * question. After a squash merge the pre-squash object survives until `git gc`
 * collects it, so the same sha reads as present on the laptop that made the
 * branch and absent on a fresh clone. Measured 2026-08-25: all four shas the
 * recent session handoffs recorded (bf781db, 915f191, 78637ef, db70bf7) are
 * readable here and reachable from no ref at all.
 *
 * Reporting object presence alone made the answer depend on which machine
 * asked, which is worse than either answer on its own.
 */
export type CommitReachability =
  /** An ancestor of the remote's default branch. The ordinary case. */
  | 'default-branch'
  /** Reachable from some ref, but not merged into the default branch. */
  | 'branch-only'
  /** The object is here and nothing points at it — squashed away, still readable. */
  | 'unreachable'

export interface CommitDetail extends CommitRow {
  reachability: CommitReachability
  /** Commit body below the subject. Empty string when there is none. */
  body: string
  files: CommitFileStat[]
}

/** Raised when the workspace cwd is not usable as a git repository. */
export class NotAGitRepoError extends Error {
  constructor(readonly cwd: string, readonly detail: string) {
    super(`not a git repository: ${cwd}`)
    this.name = 'NotAGitRepoError'
  }
}

/** Raised when a syntactically-valid sha does not resolve in this repo. */
export class UnknownShaError extends Error {
  constructor(readonly sha: string) {
    super(`unknown commit: ${sha}`)
    this.name = 'UnknownShaError'
  }
}

/**
 * The seam tests inject through. The default implementation shells out; a test
 * can substitute a reader that throws, which is the only way to exercise the
 * 409 branch without depending on the machine's filesystem layout.
 */
export interface GitCommitReader {
  assertRepo(cwd: string): void
  log(cwd: string, limit: number, before?: string): string
  hasCommit(cwd: string, sha: string): boolean
  show(cwd: string, sha: string): string
  numstat(cwd: string, sha: string): string
  /** TASK-1791 — the full unified patch for a commit. */
  patch(cwd: string, sha: string): string
  /** TASK-1784 — the remote's default ref, e.g. `origin/main`, or null. */
  defaultRef(cwd: string): string | null
  isAncestorOf(cwd: string, sha: string, ref: string): boolean
  /** Refs that contain `sha`. Empty means the object is attached to nothing. */
  containingRefs(cwd: string, sha: string): string[]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024
  })
}

export const execGitCommitReader: GitCommitReader = {
  assertRepo(cwd) {
    try {
      git(cwd, ['rev-parse', '--git-dir'])
    } catch (e) {
      throw new NotAGitRepoError(cwd, e instanceof Error ? e.message : String(e))
    }
  },
  log(cwd, limit, before) {
    // `--` terminates option parsing; `before` has already passed SHA_PATTERN,
    // but the terminator costs nothing and removes the question entirely.
    const args = ['log', `--format=${LOG_FORMAT}`, `-n`, String(limit)]
    if (before) args.push(before)
    args.push('--')
    try {
      return git(cwd, args)
    } catch (e) {
      throw new NotAGitRepoError(cwd, e instanceof Error ? e.message : String(e))
    }
  },
  hasCommit(cwd, sha) {
    try {
      git(cwd, ['cat-file', '-e', `${sha}^{commit}`])
      return true
    } catch {
      return false
    }
  },
  show(cwd, sha) {
    return git(cwd, ['show', '-s', `--format=${SHOW_FORMAT}`, sha, '--'])
  },
  numstat(cwd, sha) {
    return git(cwd, ['show', '--numstat', '--format=', sha, '--'])
  },
  patch(cwd, sha) {
    // -M detects renames, so a moved file reports as a rename rather than as a
    // whole-file delete plus a whole-file add.
    return git(cwd, ['show', '--format=', '--unified=3', '-M', sha, '--'])
  },
  defaultRef(cwd) {
    // symbolic-ref is the honest answer and it IS set in every registered
    // workspace (verified across all four on 2026-08-25). The fallbacks exist
    // because a fresh clone made with --no-checkout, or a repo whose remote was
    // added by hand, can leave origin/HEAD unset — and guessing 'main' silently
    // would misreport every commit in a repo that uses another name.
    try {
      return git(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim().replace(/^refs\/remotes\//, '')
    } catch {
      /* fall through */
    }
    for (const candidate of ['origin/main', 'origin/master']) {
      try {
        git(cwd, ['rev-parse', '--verify', '--quiet', candidate])
        return candidate
      } catch {
        /* try the next one */
      }
    }
    return null
  },
  isAncestorOf(cwd, sha, ref) {
    try {
      git(cwd, ['merge-base', '--is-ancestor', sha, ref])
      return true
    } catch {
      return false
    }
  },
  containingRefs(cwd, sha) {
    try {
      const out = git(cwd, ['branch', '-a', '--contains', sha]).trim()
      if (out === '') return []
      // `git branch --contains` marks the current branch with `*` and a
      // worktree's branch with `+`; both are noise here, only the count matters.
      return out
        .split(LINE_BREAK)
        .map((l) => l.replace(LEADING_MARKER, '').trim())
        .filter((l) => l.length > 0)
    } catch {
      return []
    }
  }
}

/**
 * Every TASK-id in a commit subject, in order, deduped.
 *
 * Measured 2026-08-25: 82 of 130 companion commits and 299 of 541 choda-deck
 * commits carry one. The other 45% are mostly `chore(release):` and pre-habit
 * features — real history, so an empty array here means "nobody tagged it",
 * never "skip this commit".
 */
export function extractTaskIds(subject: string): string[] {
  const found = subject.match(/TASK-\d+/g)
  if (!found) return []
  return [...new Set(found)]
}

/** Parse `git log --format=<LOG_FORMAT>` output. Malformed lines are dropped. */
export function parseLogOutput(raw: string): CommitRow[] {
  const rows: CommitRow[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parts = line.split(SEP)
    if (parts.length < 4) continue
    const [sha, shortSha, authorDate, ...subjectParts] = parts
    // A subject can itself contain \x1f only if someone wrote one by hand;
    // rejoining is still more faithful than truncating at the first one.
    const subject = subjectParts.join(SEP)
    rows.push({ sha, shortSha, authorDate, subject, taskIds: extractTaskIds(subject) })
  }
  return rows
}

/**
 * Parse `git show --numstat` output.
 *
 * Binary files come back as `-\t-\tpath`. They are reported as binary with null
 * counts rather than 0/0: a binary file did change, and 0/0 would say it did not.
 */
export function parseNumstat(raw: string): CommitFileStat[] {
  const files: CommitFileStat[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [ins, del, ...pathParts] = parts
    const filePath = pathParts.join('\t')
    const binary = ins === '-' || del === '-'
    files.push({
      path: filePath,
      insertions: binary ? null : Number.parseInt(ins, 10),
      deletions: binary ? null : Number.parseInt(del, 10),
      binary
    })
  }
  return files
}

export function listCommits(
  cwd: string,
  opts: { limit: number; before?: string },
  reader: GitCommitReader = execGitCommitReader
): { commits: CommitRow[]; hasMore: boolean } {
  reader.assertRepo(cwd)
  // When paginating, `before` is the last sha already shown, so git returns it
  // as row 0 and it has to be dropped. One extra row on top answers hasMore.
  const extra = opts.before ? 1 : 0
  const raw = reader.log(cwd, opts.limit + 1 + extra, opts.before)
  let rows = parseLogOutput(raw)
  if (opts.before && rows.length > 0 && rows[0]?.sha.startsWith(opts.before)) {
    rows = rows.slice(1)
  }
  const hasMore = rows.length > opts.limit
  return { commits: rows.slice(0, opts.limit), hasMore }
}

export function getCommitDetail(
  cwd: string,
  sha: string,
  reader: GitCommitReader = execGitCommitReader,
  opts: { patch?: boolean } = {}
): CommitDetail {
  reader.assertRepo(cwd)
  // Repo-level health is established above, so a miss here is genuinely about
  // this sha — which is the pre-squash-orphan case, and a 404 rather than a 409.
  if (!reader.hasCommit(cwd, sha)) throw new UnknownShaError(sha)

  const reachability = resolveReachability(cwd, sha, reader)
  const parts = reader.show(cwd, sha).split(SEP)
  const [full, shortSha, authorDate, subject, ...bodyParts] = parts
  const body = bodyParts.join(SEP).trim()
  return {
    sha: full,
    shortSha,
    authorDate,
    subject,
    taskIds: extractTaskIds(subject ?? ''),
    reachability,
    body,
    files: withHunks(parseNumstat(reader.numstat(cwd, sha)), cwd, sha, reader, opts.patch === true)
  }
}

/**
 * Attach hunks to the stat rows, matching on path.
 *
 * The stat is the source of truth for WHICH files changed; the patch only says
 * how. A file the patch does not mention keeps its stat and gets no hunks key
 * at all, rather than an empty array claiming it changed nothing.
 */
function withHunks(
  files: CommitFileStat[],
  cwd: string,
  sha: string,
  reader: GitCommitReader,
  wanted: boolean
): CommitFileStat[] {
  if (!wanted) return files
  const byPath = new Map(parseUnifiedDiff(reader.patch(cwd, sha)).map((d) => [d.path, d]))
  return files.map((f) => {
    const d = byPath.get(f.path)
    if (!d) return f
    return {
      ...f,
      hunks: d.hunks,
      ...(d.omitted ? { omitted: d.omitted } : {}),
      ...(d.oldPath ? { oldPath: d.oldPath } : {})
    }
  })
}

/**
 * Which of the three attached states this commit is in. The fourth state,
 * absent, never reaches here: getCommitDetail throws UnknownShaError first and
 * the route answers 404, because an object that is not here has no detail to
 * report.
 *
 * With no resolvable default ref the answer degrades to branch-only rather than
 * default-branch. Claiming a commit is merged when we could not check is the
 * dangerous direction; claiming it is only on a branch merely under-states it.
 */
export function resolveReachability(
  cwd: string,
  sha: string,
  reader: GitCommitReader = execGitCommitReader
): CommitReachability {
  const ref = reader.defaultRef(cwd)
  if (ref !== null && reader.isAncestorOf(cwd, sha, ref)) return 'default-branch'
  return reader.containingRefs(cwd, sha).length > 0 ? 'branch-only' : 'unreachable'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same constant-time compare as artifacts, vault and workspace-docs, duplicated
// rather than exported so this module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > MAX_LIMIT) return null
  return n
}

/**
 * GET /workspaces/<id>/commits?limit=100&before=<sha>
 *   200 { workspaceId, label, cwd, commits: CommitRow[], hasMore }
 *   409 { error, workspaceId, label, cwd }  — cwd gone, or not a git repo
 *
 * GET /workspaces/<id>/commits/<sha>
 *   200 CommitDetail
 *   404 — sha does not resolve here (the pre-squash orphan case)
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router (mirrors handleWorkspaceDocsRoute).
 */
export async function handleWorkspaceCommitsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { svc: WorkspaceOperations; bridgeToken: string; reader?: GitCommitReader }
): Promise<boolean> {
  const rawPath = (req.url ?? '/').split('?')[0]
  if (!rawPath.startsWith(ROUTE_PREFIX)) return false

  const rest = rawPath.slice(ROUTE_PREFIX.length)
  const idx = rest.indexOf(COMMITS_SEGMENT)
  if (idx <= 0) return false
  const tail = rest.slice(idx + COMMITS_SEGMENT.length)
  // Only `/commits` and `/commits/<sha>` are ours. `/commits-something` is not.
  if (tail !== '' && !tail.startsWith('/')) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const workspaceId = decodeURIComponent(rest.slice(0, idx))
  const workspace = await opts.svc.getWorkspace(workspaceId)
  if (!workspace) {
    sendJson(res, 404, { error: `unknown workspace: ${workspaceId}` })
    return true
  }

  // A cwd that is gone is the same class of failure as a cwd that is not a
  // repo, and workspace-docs already answers 409 for it. Checking here keeps the
  // two paths reporting one thing.
  if (!fs.existsSync(workspace.cwd)) {
    sendJson(res, 409, {
      error: 'workspace cwd does not exist',
      workspaceId,
      label: workspace.label,
      cwd: workspace.cwd
    })
    return true
  }

  const reader = opts.reader ?? execGitCommitReader
  const conflict = (): void => {
    sendJson(res, 409, {
      error: 'workspace cwd is not a git repository',
      workspaceId,
      label: workspace.label,
      cwd: workspace.cwd
    })
  }

  if (tail === '') {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams
    const limit = parseLimit(params.get('limit'))
    if (limit === null) {
      sendJson(res, 400, { error: `limit must be an integer between 1 and ${MAX_LIMIT}` })
      return true
    }
    const before = params.get('before') ?? undefined
    if (before !== undefined && !SHA_PATTERN.test(before)) {
      sendJson(res, 400, { error: 'before must be a hex sha' })
      return true
    }
    try {
      const { commits, hasMore } = listCommits(workspace.cwd, { limit, before }, reader)
      sendJson(res, 200, {
        workspaceId,
        label: workspace.label,
        cwd: workspace.cwd,
        commits,
        hasMore
      })
    } catch (e) {
      if (e instanceof NotAGitRepoError) conflict()
      else throw e
    }
    return true
  }

  const sha = decodeURIComponent(tail.slice(1))
  if (!SHA_PATTERN.test(sha)) {
    sendJson(res, 400, { error: 'sha must be hex, 4 to 40 characters' })
    return true
  }
  // TASK-1791 — a new OPTIONAL param, so an adapter without it answers as it
  // always did rather than 404ing a route the client had to guess about
  // (the TASK-1787 precedent; the vendored bundle lags a release, INBOX-1888).
  const wantPatch = new URL(req.url ?? '/', 'http://localhost').searchParams.get('patch') === '1'
  try {
    sendJson(res, 200, getCommitDetail(workspace.cwd, sha, reader, { patch: wantPatch }))
  } catch (e) {
    if (e instanceof UnknownShaError) {
      sendJson(res, 404, { error: `unknown commit: ${sha}`, workspaceId, cwd: workspace.cwd })
    } else if (e instanceof NotAGitRepoError) {
      conflict()
    } else {
      throw e
    }
  }
  return true
}
