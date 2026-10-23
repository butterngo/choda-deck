import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { scanWorkspaces, type Exec } from './workspace-scan'

// TASK-2671 — fixture repos are real git repositories in a temp dir; failures,
// gh and timeouts are injected through `exec`, which wraps the real one.

let tmp: string

const g = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8'
  }).trim()

/** A repo with one commit on `branch` and origin/HEAD pointing at it (no real remote needed). */
function makeRepo(name: string, branch = 'main'): string {
  const repo = path.join(tmp, name)
  fs.mkdirSync(repo, { recursive: true })
  g(repo, 'init', '-q', '-b', branch)
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a')
  g(repo, 'add', 'a.txt')
  g(repo, 'commit', '-q', '-m', 'init')
  g(repo, 'update-ref', `refs/remotes/origin/${branch}`, 'HEAD')
  g(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`)
  return repo
}

const realExec: Exec = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    try {
      resolve(execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (err) {
      reject(err)
    }
  })

/** gh is never real in these tests: a stub that answers "no open PRs". */
const noPrs: Exec = (cmd, args, cwd) =>
  cmd === 'gh' ? Promise.resolve('[]') : realExec(cmd, args, cwd)

const ws = (id: string, cwd: string, projectId = 'p') => ({ id, projectId, cwd })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-scan-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('scanWorkspaces', () => {
  it('AC-1: a workspace whose cwd does not exist is missing', async () => {
    const [r] = await scanWorkspaces([ws('gone', path.join(tmp, 'nope'))], { exec: noPrs })
    expect(r.state).toBe('missing')
    expect(r.workspaceIds).toEqual(['gone'])
    expect(r.dirtyFiles).toBeNull()
  })

  it('AC-2: a cwd outside any git repo is not-a-repo', async () => {
    const plain = path.join(tmp, 'plain')
    fs.mkdirSync(plain)
    // GIT_CEILING_DIRECTORIES stops git walking up out of the temp dir into a parent repo.
    const exec: Exec = (cmd, args, cwd) =>
      new Promise((resolve, reject) => {
        try {
          resolve(
            execFileSync(cmd, args, {
              cwd,
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, GIT_CEILING_DIRECTORIES: tmp }
            })
          )
        } catch (err) {
          reject(err)
        }
      })
    const [r] = await scanWorkspaces([ws('plain', plain)], { exec })
    expect(r.state).toBe('not-a-repo')
    expect(r.unmergedBranches).toBeNull()
  })

  it('AC-3: a git call that fails makes the repo failed with null counts — never 0 or []', async () => {
    const repo = makeRepo('r')
    const exec: Exec = (cmd, args, cwd) =>
      cmd === 'git' && args[0] === 'status'
        ? Promise.reject(Object.assign(new Error('boom'), { stderr: 'fatal: index file corrupt' }))
        : noPrs(cmd, args, cwd)
    const [r] = await scanWorkspaces([ws('r', repo)], { exec })
    expect(r.state).toBe('failed')
    expect(r.reason).toBe('fatal: index file corrupt')
    expect(r.dirtyFiles).toBeNull()
    expect(r.unmergedBranches).toBeNull()
  })

  it('AC-4: two workspaces in one repository produce one entry listing both', async () => {
    const repo = makeRepo('tms')
    const fe = path.join(repo, 'fe')
    fs.mkdirSync(fe)
    fs.writeFileSync(path.join(fe, 'x.txt'), 'x')
    g(repo, 'add', '.')
    g(repo, 'commit', '-q', '-m', 'fe')
    const out = await scanWorkspaces([ws('BE', repo, 'tms'), ws('FE', fe, 'tms')], { exec: noPrs })
    expect(out).toHaveLength(1)
    expect(out[0].workspaceIds.sort()).toEqual(['BE', 'FE'])
    expect(out[0].state).toBe('ok')
  })

  it('AC-5: on a repo whose origin/HEAD is master, unmerged lists the branch with an extra commit and not the merged one', async () => {
    const repo = makeRepo('m', 'master')
    g(repo, 'branch', 'merged-one')
    g(repo, 'switch', '-q', '-c', 'feature')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b')
    g(repo, 'add', 'b.txt')
    g(repo, 'commit', '-q', '-m', 'feature work')
    g(repo, 'switch', '-q', 'master')
    const [r] = await scanWorkspaces([ws('m', repo)], { exec: noPrs })
    expect(r.defaultBranch).toBe('master')
    expect(r.unmergedBranches).toEqual(['feature'])
  })

  it('AC-6: two untracked files report dirtyFiles 2', async () => {
    const repo = makeRepo('d')
    fs.writeFileSync(path.join(repo, 'u1.txt'), '1')
    fs.writeFileSync(path.join(repo, 'u2.txt'), '2')
    const [r] = await scanWorkspaces([ws('d', repo)], { exec: noPrs })
    expect(r.dirtyFiles).toBe(2)
  })

  it('AC-7: gh exiting 1 leaves prs unknown while the git fields are filled', async () => {
    const repo = makeRepo('g')
    fs.writeFileSync(path.join(repo, 'u.txt'), 'u')
    const exec: Exec = (cmd, args, cwd) =>
      cmd === 'gh'
        ? Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'HTTP 403' }))
        : realExec(cmd, args, cwd)
    const [r] = await scanWorkspaces([ws('g', repo)], { exec })
    expect(r.state).toBe('ok')
    expect(r.prs).toBe('unknown')
    expect(r.openPrs).toEqual([])
    expect(r.dirtyFiles).toBe(1)
    expect(r.unmergedBranches).toEqual([])
  })

  it('AC-8: a git call past timeoutMs makes that repo failed/timeout and the scan still returns the others', async () => {
    const slow = makeRepo('slow')
    const fast = makeRepo('fast')
    const exec: Exec = (cmd, args, cwd) =>
      cmd === 'git' &&
      args[0] === 'status' &&
      cwd.replace(/\\/g, '/').toLowerCase().endsWith('/slow')
        ? new Promise<string>(() => {}) // never settles
        : noPrs(cmd, args, cwd)
    const out = await scanWorkspaces([ws('slow', slow), ws('fast', fast)], { exec, timeoutMs: 300 })
    const bySlow = out.find((r) => r.workspaceIds.includes('slow'))!
    const byFast = out.find((r) => r.workspaceIds.includes('fast'))!
    expect(bySlow.state).toBe('failed')
    expect(bySlow.reason).toBe('timeout')
    expect(byFast.state).toBe('ok')
  })
})
