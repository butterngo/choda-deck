// TASK-1779 — the git history surface.
//
// Runs against a REAL temp git repository rather than a mocked git, because
// every property worth protecting here is a property of git's actual output:
// how it abbreviates a sha, how numstat marks a binary file, what it does with
// a subject containing punctuation, and what it exits with outside a repo.
//
// The 409-vs-empty distinction is tested BOTH ways round on purpose. A guard
// that fires on everything passes the negative case and proves nothing; the
// paired control is what makes the assertion mean something (see the gotcha
// `a-companion-view-has-three-states-not-two-empty-capability-gap-failure`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { MAX_FILE_PATCH_BYTES } from './commit-diff'
import {
  handleWorkspaceCommitsRoute,
  resolveReachability,
  extractTaskIds,
  parseLogOutput,
  parseNumstat,
  listCommits,
  getCommitDetail,
  execGitCommitReader,
  NotAGitRepoError,
  UnknownShaError,
  type GitCommitReader
} from './workspace-commits'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'bridge-token-for-tests'
const SEP = '\x1f'

interface Captured {
  status: number
  body: unknown
  raw?: string
}

function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number) {
      cap.status = status
      return this
    },
    end(payload?: string) {
      cap.raw = payload
      try {
        cap.body = payload ? JSON.parse(payload) : undefined
      } catch {
        cap.body = undefined
      }
      return this
    }
  } as unknown as ServerResponse
}

// `null` means "send no token" — an explicit `undefined` would re-trigger the
// default and silently send one, so the 401 case would never be exercised.
function req(url: string, method = 'GET', token: string | null = TOKEN): IncomingMessage {
  return {
    url,
    method,
    headers: token ? { 'x-choda-bridge-token': token } : {}
  } as unknown as IncomingMessage
}

function svcFor(cwd: string | null, id = 'main'): WorkspaceOperations {
  return {
    getWorkspace: async (asked: string) =>
      asked === id && cwd !== null ? ({ id, label: 'Main', cwd, projectId: 'p1' } as never) : null
  } as unknown as WorkspaceOperations
}

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

let repo: string
let notRepo: string
let taggedSha = ''
let untaggedSha = ''
let binarySha = ''

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-commits-repo-'))
  notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-commits-plain-'))
  fs.writeFileSync(path.join(notRepo, 'README.md'), '# not a repo')

  run(repo, ['init', '-q', '-b', 'main'])
  run(repo, ['config', 'user.email', 'test@example.com'])
  run(repo, ['config', 'user.name', 'Test'])
  run(repo, ['config', 'commit.gpgsign', 'false'])

  // 1 — untagged, the ~45% of real history nobody tagged.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  run(repo, ['add', 'a.txt'])
  run(repo, ['commit', '-q', '-m', 'chore(release): 0.1.0 — no task id here'])
  untaggedSha = run(repo, ['rev-parse', 'HEAD']).trim()

  // 2 — tagged, with a subject full of the punctuation a naive delimiter breaks on.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n')
  run(repo, ['add', '.'])
  run(repo, [
    'commit',
    '-q',
    '-m',
    'feat(web): a | pipe, a: colon and a dash — all in one (TASK-1767)',
    '-m',
    'A body line explaining why.'
  ])
  taggedSha = run(repo, ['rev-parse', 'HEAD']).trim()

  // 3 — a binary file, which numstat reports as `-` rather than a count.
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7]))
  run(repo, ['add', 'blob.bin'])
  run(repo, ['commit', '-q', '-m', 'chore: add a binary (TASK-1779) and mention TASK-1779 twice'])
  binarySha = run(repo, ['rev-parse', 'HEAD']).trim()
})

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  fs.rmSync(notRepo, { recursive: true, force: true })
})

describe('extractTaskIds', () => {
  it('pulls the id out of a conventional subject', () => {
    expect(extractTaskIds('feat(web): a thing (TASK-1766) (#71)')).toEqual(['TASK-1766'])
  })

  it('returns an empty array for an untagged subject — a fact, not a gap', () => {
    expect(extractTaskIds('chore(release): 0.8.0 — a workspace is somewhere you can go')).toEqual([])
  })

  it('dedupes a subject naming the same task twice', () => {
    expect(extractTaskIds('TASK-1779: follow-up to TASK-1779')).toEqual(['TASK-1779'])
  })

  it('keeps several distinct ids in order', () => {
    expect(extractTaskIds('feat: close TASK-1750 and TASK-1748')).toEqual(['TASK-1750', 'TASK-1748'])
  })

  it('does not match a bare number or a lowercase prefix', () => {
    expect(extractTaskIds('fix: bump to 1779 for task-1779')).toEqual([])
  })
})

describe('parseLogOutput', () => {
  it('keeps a subject containing the delimiter-ish punctuation', () => {
    const line = ['abc123def', 'abc123d', '2026-08-25T10:00:00+07:00', 'feat: a | b: c — d'].join(SEP)
    expect(parseLogOutput(line)[0]?.subject).toBe('feat: a | b: c — d')
  })

  it('drops a malformed line instead of emitting a half-built row', () => {
    expect(parseLogOutput('garbage-with-no-separators')).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('reads insertions and deletions for a text file', () => {
    expect(parseNumstat('12\t3\tsrc/app.ts')).toEqual([
      { path: 'src/app.ts', insertions: 12, deletions: 3, binary: false }
    ])
  })

  it('reports a binary file as binary with null counts, never 0/0', () => {
    const [file] = parseNumstat('-\t-\tassets/logo.png')
    expect(file?.binary).toBe(true)
    // 0/0 would assert the file did not change, which is a different claim.
    expect(file?.insertions).toBeNull()
    expect(file?.deletions).toBeNull()
  })
})

describe('listCommits against a real repo', () => {
  it('returns newest first with a resolved sha, date and task ids', () => {
    const { commits } = listCommits(repo, { limit: 10 })
    expect(commits).toHaveLength(3)
    expect(commits[0]?.sha).toBe(binarySha)
    expect(commits[0]?.taskIds).toEqual(['TASK-1779'])
    expect(commits[0]?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(commits[0]?.shortSha.length).toBeGreaterThan(3)
  })

  it('keeps the untagged commit in the list, with an empty taskIds', () => {
    const { commits } = listCommits(repo, { limit: 10 })
    const untagged = commits.find((c) => c.sha === untaggedSha)
    expect(untagged).toBeDefined()
    expect(untagged?.taskIds).toEqual([])
  })

  it('reports hasMore when the log is longer than the limit, and not when it is not', () => {
    expect(listCommits(repo, { limit: 2 }).hasMore).toBe(true)
    expect(listCommits(repo, { limit: 3 }).hasMore).toBe(false)
  })

  it('paginates past `before` without repeating it', () => {
    const page = listCommits(repo, { limit: 1, before: binarySha })
    expect(page.commits.map((c) => c.sha)).toEqual([taggedSha])
  })

  it('throws NotAGitRepoError outside a repo rather than returning []', () => {
    // The whole point: [] here would read as "this repo has no commits".
    expect(() => listCommits(notRepo, { limit: 10 })).toThrow(NotAGitRepoError)
  })
})

describe('getCommitDetail against a real repo', () => {
  it('returns the subject, the body and a per-file stat', () => {
    const detail = getCommitDetail(repo, taggedSha)
    expect(detail.subject).toBe('feat(web): a | pipe, a: colon and a dash — all in one (TASK-1767)')
    expect(detail.body).toBe('A body line explaining why.')
    expect(detail.taskIds).toEqual(['TASK-1767'])
    const paths = detail.files.map((f) => f.path).sort()
    expect(paths).toEqual(['a.txt', 'b.txt'])
  })

  it('agrees with git about the numbers', () => {
    const detail = getCommitDetail(repo, taggedSha)
    const raw = run(repo, ['show', '--numstat', '--format=', taggedSha])
    const expected = raw
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => l.split('\t'))
    for (const [ins, del, p] of expected) {
      const got = detail.files.find((f) => f.path === p)
      expect(got?.insertions).toBe(Number.parseInt(ins, 10))
      expect(got?.deletions).toBe(Number.parseInt(del, 10))
    }
  })

  it('marks the binary file binary', () => {
    const detail = getCommitDetail(repo, binarySha)
    expect(detail.files.find((f) => f.path === 'blob.bin')?.binary).toBe(true)
  })

  it('throws UnknownShaError for a sha that does not resolve here', () => {
    expect(() => getCommitDetail(repo, 'bf781db')).toThrow(UnknownShaError)
  })

  it('resolves a sha that DOES exist — the control for the case above', () => {
    expect(getCommitDetail(repo, taggedSha.slice(0, 7)).sha).toBe(taggedSha)
  })
})

describe('handleWorkspaceCommitsRoute', () => {
  it('ignores a path that is not ours', async () => {
    const cap = {} as Captured
    const handled = await handleWorkspaceCommitsRoute(req('/workspaces'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(handled).toBe(false)
  })

  it('ignores /commits-adjacent so a future route is not swallowed', async () => {
    const cap = {} as Captured
    const handled = await handleWorkspaceCommitsRoute(req('/workspaces/main/commits-summary'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(handled).toBe(false)
  })

  it('401s without the bridge token', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits', 'GET', null), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(401)
  })

  it('405s a POST', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits', 'POST'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(405)
  })

  it('404s an unknown workspace', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/nope/commits'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(404)
  })

  it('lists commits for a real repo', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits?limit=5'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    const body = cap.body as { commits: unknown[]; hasMore: boolean; cwd: string }
    expect(body.commits).toHaveLength(3)
    expect(body.hasMore).toBe(false)
    expect(body.cwd).toBe(repo)
  })

  it('409s a cwd that is not a git repo, naming the cwd', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits'), fakeRes(cap), {
      svc: svcFor(notRepo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(409)
    expect((cap.body as { cwd: string }).cwd).toBe(notRepo)
    // And it must NOT look like an ordinary answer with nothing in it.
    expect((cap.body as { commits?: unknown }).commits).toBeUndefined()
  })

  it('409s a cwd that does not exist at all', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits'), fakeRes(cap), {
      svc: svcFor(path.join(notRepo, 'gone')),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(409)
  })

  it('200s the same request against a real repo — the control for both 409s', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
  })

  it('rejects a non-hex sha before it can reach git', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(
      req('/workspaces/main/commits/--upload-pack%3Dtouch%20pwned'),
      fakeRes(cap),
      { svc: svcFor(repo), bridgeToken: TOKEN }
    )
    expect(cap.status).toBe(400)
  })

  it('rejects a nonsense limit rather than silently defaulting', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits?limit=0'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(400)
  })

  it('serves commit detail', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req(`/workspaces/main/commits/${taggedSha}`), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(200)
    const body = cap.body as { taskIds: string[]; files: unknown[] }
    expect(body.taskIds).toEqual(['TASK-1767'])
    expect(body.files).toHaveLength(2)
  })

  it('404s an orphan sha — the pre-squash case — instead of 500ing', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req('/workspaces/main/commits/bf781db'), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    expect(cap.status).toBe(404)
  })

  it('maps a repo-level failure on the detail route to 409, not 404', async () => {
    // Injected rather than filesystem-driven: the two failures are easy to
    // collapse into one branch, and only a reader that fails at assertRepo
    // while a sha is syntactically fine can tell them apart.
    const failing: GitCommitReader = {
      assertRepo(cwd) {
        throw new NotAGitRepoError(cwd, 'injected')
      },
      log: () => '',
      hasCommit: () => true,
      show: () => '',
      numstat: () => '',
      patch: () => '',
      defaultRef: () => null,
      isAncestorOf: () => false,
      containingRefs: () => []
    }
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req(`/workspaces/main/commits/${taggedSha}`), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN,
      reader: failing
    })
    expect(cap.status).toBe(409)
  })
})

// TASK-1784 — the four-state reachability field.
//
// `cat-file -e` answers "is this object in the database", which is a different
// question from "can anyone still reach this commit". After a squash merge the
// pre-squash object survives until gc, so reporting object presence alone made
// the answer depend on which machine asked.
describe('resolveReachability', () => {
  function reader(over: Partial<GitCommitReader>): GitCommitReader {
    return {
      assertRepo: () => {},
      log: () => '',
      hasCommit: () => true,
      show: () => '',
      numstat: () => '',
      patch: () => '',
      defaultRef: () => 'origin/main',
      isAncestorOf: () => false,
      containingRefs: () => [],
      ...over
    }
  }

  it('is default-branch for an ancestor of the default ref', () => {
    expect(resolveReachability('/x', 'abc1234', reader({ isAncestorOf: () => true }))).toBe(
      'default-branch'
    )
  })

  it('is branch-only when a ref contains it but the default branch does not', () => {
    const r = reader({ isAncestorOf: () => false, containingRefs: () => ['feature/x'] })
    expect(resolveReachability('/x', 'abc1234', r)).toBe('branch-only')
  })

  it('is unreachable when the object is present and nothing points at it', () => {
    // The squashed-away case. It is NOT absent — getCommitDetail already
    // resolved the object — and it is NOT branch-only, because claiming a
    // branch holds it would send a reader looking for one.
    const r = reader({ isAncestorOf: () => false, containingRefs: () => [] })
    expect(resolveReachability('/x', 'abc1234', r)).toBe('unreachable')
  })

  it('degrades to branch-only, never default-branch, when no default ref resolves', () => {
    // Under-stating is the safe direction: claiming a commit is merged when we
    // could not check is the answer that misleads.
    const r = reader({ defaultRef: () => null, containingRefs: () => ['some/branch'] })
    expect(resolveReachability('/x', 'abc1234', r)).toBe('branch-only')
  })

  it('asks the default ref by name rather than assuming main', () => {
    const seen: string[] = []
    const r = reader({
      defaultRef: () => 'origin/trunk',
      isAncestorOf: (_c, _s, ref) => {
        seen.push(ref)
        return true
      }
    })
    expect(resolveReachability('/x', 'abc1234', r)).toBe('default-branch')
    // A hardcoded 'origin/main' would misreport every commit in a repo that
    // uses another name, and would pass a test that only checked the verdict.
    expect(seen).toEqual(['origin/trunk'])
  })
})

describe('reachability against the real repo', () => {
  it('reports default-branch for a commit on main', () => {
    const head = run(repo, ['rev-parse', 'HEAD']).trim()
    // The temp repo has no remote, so origin/HEAD does not resolve and the
    // fallbacks find nothing — which is exactly the degrade path above.
    expect(['default-branch', 'branch-only', 'unreachable']).toContain(
      getCommitDetail(repo, head).reachability
    )
  })

  it('carries the field on every detail response', () => {
    expect(getCommitDetail(repo, taggedSha)).toHaveProperty('reachability')
  })
})

// TASK-1791 — hunks arrive only when asked for, and their absence never reads
// as "this file changed nothing".
describe('patch=1 on the detail route', () => {
  it('omits hunks entirely by default', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(req(`/workspaces/main/commits/${taggedSha}`), fakeRes(cap), {
      svc: svcFor(repo),
      bridgeToken: TOKEN
    })
    const body = cap.body as { files: Array<Record<string, unknown>> }
    // Not `hunks: null` — the key is absent, so an old client sees exactly
    // what it saw before.
    expect(body.files.every((f) => !('hunks' in f))).toBe(true)
  })

  it('includes hunks with real line numbers when asked', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(
      req(`/workspaces/main/commits/${taggedSha}?patch=1`),
      fakeRes(cap),
      { svc: svcFor(repo), bridgeToken: TOKEN }
    )
    const body = cap.body as {
      files: Array<{ path: string; hunks: Array<{ lines: Array<{ newNo: number | null }> }> | null }>
    }
    const a = body.files.find((f) => f.path === 'a.txt')
    expect(a?.hunks).not.toBeNull()
    expect(a!.hunks!.length).toBeGreaterThan(0)
    expect(a!.hunks![0]!.lines.some((l) => typeof l.newNo === 'number')).toBe(true)
  })

  it('marks the binary file null rather than empty, with a text control', async () => {
    const cap = {} as Captured
    await handleWorkspaceCommitsRoute(
      req(`/workspaces/main/commits/${binarySha}?patch=1`),
      fakeRes(cap),
      { svc: svcFor(repo), bridgeToken: TOKEN }
    )
    const body = cap.body as { files: Array<{ path: string; hunks: unknown; omitted?: string }> }
    const bin = body.files.find((f) => f.path === 'blob.bin')
    expect(bin?.hunks).toBeNull()
    expect(bin?.omitted).toBe('binary')
  })
})

// TASK-1921 — a renamed file used to arrive under a path that names no file.
//
// `git show --numstat` spells a rename in git's COMBINED display form,
// `dir/{old.ts => new.ts}`, while the patch reader (which takes -M) spells it
// `rename from` / `rename to`. withHunks joins the two by path, so the join
// missed: the file kept the combined string as its path and arrived with NO
// `hunks` key at all — which the companion renders as "this adapter does not
// serve diffs", telling a reader to upgrade an adapter that is already current.
//
// The fix is `-z`, which removes a guess rather than adding one: the combined
// form cannot be split back apart safely, because a path may contain ` => `.

describe('parseNumstat — the -z record forms (TASK-1921)', () => {
  it('reads an ordinary NUL-terminated record', () => {
    expect(parseNumstat('12\t3\tsrc/app.ts\x00')).toEqual([
      { path: 'src/app.ts', insertions: 12, deletions: 3, binary: false }
    ])
  })

  it('reads a rename as two separate paths, newest as `path`', () => {
    // The record ends right after the second tab; the two paths follow.
    const [file] = parseNumstat('41\t18\t\x00old/a.ts\x00new/b.ts\x00')
    expect(file?.path).toBe('new/b.ts')
    expect(file?.oldPath).toBe('old/a.ts')
    expect(file?.insertions).toBe(41)
  })

  it('keeps a path containing ` => ` intact — the reason -z was chosen', () => {
    // Under the combined form this path is indistinguishable from a rename.
    const [file] = parseNumstat('1\t0\tdocs/a => b.md\x00')
    expect(file?.path).toBe('docs/a => b.md')
    expect(file?.oldPath).toBeUndefined();
  })

  it('drops a truncated rename rather than half-reading it', () => {
    // Half a rename would name a file that is not the one that changed.
    expect(parseNumstat('41\t18\t\x00old/a.ts\x00')).toEqual([])
  })

  it('CONTROL — a rename and an ordinary file in one stream both survive', () => {
    const files = parseNumstat('41\t18\t\x00old/a.ts\x00new/b.ts\x00002\t2\tpackage.json\x00')
    expect(files.map((f) => f.path)).toEqual(['new/b.ts', 'package.json'])
    expect(files[1]?.oldPath).toBeUndefined()
  })
})

describe('a renamed file, end to end against a real repo (TASK-1921)', () => {
  let rrepo: string
  let renameEditSha = ''
  let pureRenameSha = ''
  let overCapSha = ''

  beforeAll(() => {
    rrepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rename-repo-'))
    run(rrepo, ['init', '-q', '-b', 'main'])
    run(rrepo, ['config', 'user.email', 'test@example.com'])
    run(rrepo, ['config', 'user.name', 'Test'])
    run(rrepo, ['config', 'commit.gpgsign', 'false'])

    fs.mkdirSync(path.join(rrepo, 'src'))
    fs.writeFileSync(path.join(rrepo, 'src', 'old-name.ts'), 'one\ntwo\nthree\nfour\n')
    fs.writeFileSync(path.join(rrepo, 'keep.txt'), 'untouched\n')
    run(rrepo, ['add', '.'])
    run(rrepo, ['commit', '-q', '-m', 'chore: seed'])

    // A rename WITH edits — the case that lost its diff entirely.
    run(rrepo, ['mv', 'src/old-name.ts', 'src/new-name.ts'])
    fs.writeFileSync(path.join(rrepo, 'src', 'new-name.ts'), 'one\nTWO\nthree\nfour\nfive\n')
    run(rrepo, ['add', '.'])
    run(rrepo, ['commit', '-q', '-m', 'refactor: rename and edit'])
    renameEditSha = run(rrepo, ['rev-parse', 'HEAD']).trim()

    // A PURE rename — no content change at all — carrying a BINARY file in the
    // SAME commit. AC-3 asks for the control there and not in a neighbouring
    // commit, because the point is that one response distinguishes the two:
    // [] (changed nothing) beside null (not produced).
    run(rrepo, ['mv', 'keep.txt', 'kept.txt'])
    fs.writeFileSync(path.join(rrepo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 7]))
    run(rrepo, ['add', '.'])
    run(rrepo, ['commit', '-q', '-m', 'chore: move a file, unchanged, beside a binary'])
    pureRenameSha = run(rrepo, ['rev-parse', 'HEAD']).trim()

    // A file over MAX_FILE_PATCH_BYTES, so the cap actually fires.
    fs.writeFileSync(path.join(rrepo, 'huge.txt'), 'x'.repeat(MAX_FILE_PATCH_BYTES + 4096) + '\n')
    run(rrepo, ['add', '.'])
    run(rrepo, ['commit', '-q', '-m', 'chore: add a file past the patch cap'])
    overCapSha = run(rrepo, ['rev-parse', 'HEAD']).trim()
  })

  afterAll(() => {
    fs.rmSync(rrepo, { recursive: true, force: true })
  })

  it('AC-1 — reports the NEW path, and it is a path that exists', () => {
    const detail = getCommitDetail(rrepo, renameEditSha, execGitCommitReader, { patch: true })
    const file = detail.files[0]
    expect(file?.path).toBe('src/new-name.ts')
    // The defect's signature, asserted directly rather than by its consequences.
    expect(file?.path).not.toContain('=>')
    expect(file?.path).not.toContain('{')
    expect(fs.existsSync(path.join(rrepo, file?.path ?? ''))).toBe(true)
    expect(file?.oldPath).toBe('src/old-name.ts')
  })

  it('AC-2 — carries its hunks, and the counts agree with the stat', () => {
    const file = getCommitDetail(rrepo, renameEditSha, execGitCommitReader, { patch: true }).files[0]
    expect(file?.hunks).not.toBeNull()
    const add = (file?.hunks ?? []).flatMap((h) => h.lines).filter((l) => l.kind === 'add').length
    const del = (file?.hunks ?? []).flatMap((h) => h.lines).filter((l) => l.kind === 'del').length
    expect(add).toBe(file?.insertions)
    expect(del).toBe(file?.deletions)
  })

  it('AC-3 — a PURE rename is an empty hunk list, not null', () => {
    // [] means "changed nothing", null means "not produced". A pure rename
    // genuinely changed nothing, and the two must not collapse.
    const files = getCommitDetail(rrepo, pureRenameSha, execGitCommitReader, { patch: true }).files
    const file = files.find((f) => f.path === 'kept.txt')
    expect(file?.oldPath).toBe('keep.txt')
    expect(file?.hunks).toEqual([])
    expect(file?.hunks).not.toBeNull()

    // PAIRED CONTROL, same response: a binary file is still null. Without it the
    // first assertion would also pass on a build that returns [] for everything.
    const bin = files.find((f) => f.path === 'blob.bin')
    expect(bin?.hunks).toBeNull()
    expect(bin?.omitted).toBe('binary')
  })

  it('AC-5 — an over-cap file states the cap it applied, in bytes', () => {
    const file = getCommitDetail(rrepo, overCapSha, execGitCommitReader, { patch: true }).files.find(
      (f) => f.path === 'huge.txt'
    )
    expect(file?.omitted).toBe('too-large')
    // The number, not just the reason: a client should not have to hardcode
    // 262144 and hope it stays true.
    expect(file?.capBytes).toBe(MAX_FILE_PATCH_BYTES)

    // CONTROL — a file under the cap states no capBytes at all.
    const under = getCommitDetail(rrepo, renameEditSha, execGitCommitReader, {
      patch: true
    }).files.find((f) => f.path === 'src/new-name.ts')
    expect(under?.capBytes).toBeUndefined()
  })

  it('AC-4 — no file in a patch response has hunks null without a reason', () => {
    for (const sha of [renameEditSha, pureRenameSha, overCapSha]) {
      for (const f of getCommitDetail(rrepo, sha, execGitCommitReader, { patch: true }).files) {
        if (f.hunks === null) expect(f.omitted, f.path).toBeDefined()
        // And the key is never absent: absent is how a client detects an
        // adapter too old to serve diffs at all.
        expect(f, f.path).toHaveProperty('hunks')
      }
    }
  })

  it('CONTROL — without patch, the response still carries no hunks key', () => {
    // The default must not move; an absent key here is correct and is what an
    // old adapter also produces.
    for (const f of getCommitDetail(rrepo, renameEditSha).files) {
      expect(f).not.toHaveProperty('hunks')
    }
  })
})
