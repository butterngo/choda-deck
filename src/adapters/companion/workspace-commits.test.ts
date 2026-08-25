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
import {
  handleWorkspaceCommitsRoute,
  extractTaskIds,
  parseLogOutput,
  parseNumstat,
  listCommits,
  getCommitDetail,
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
      numstat: () => ''
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
