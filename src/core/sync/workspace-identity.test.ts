import { describe, it, expect } from 'vitest'
import * as path from 'path'
import {
  computeWorkspaceIdentity,
  computeWorkspaceIdentities,
  type GitCommands
} from './workspace-identity'

function fakeGit(handlers: Partial<GitCommands>): GitCommands {
  return {
    gitCommonDir: handlers.gitCommonDir ?? (() => null),
    showToplevel: handlers.showToplevel ?? (() => null),
    getRemoteOrigin: handlers.getRemoteOrigin ?? (() => null)
  }
}

describe('computeWorkspaceIdentity (AC #3)', () => {
  it('monorepo case: 2 workspaces in same repo, different subpaths produce 1 dedup remote + 2 distinct identities', () => {
    const repoRoot = path.resolve('/repos/choda-deck')
    const git = fakeGit({
      gitCommonDir: () => path.join(repoRoot, '.git'),
      showToplevel: () => repoRoot,
      getRemoteOrigin: () => 'git@github.com:butterngo/choda-deck.git'
    })

    const a = computeWorkspaceIdentity({ id: 'main', cwd: repoRoot }, 'choda-deck', git)
    const b = computeWorkspaceIdentity(
      { id: 'docs', cwd: path.join(repoRoot, 'docs') },
      'choda-deck',
      git
    )

    expect(a.canonicalGitRemote).toBe('github.com/butterngo/choda-deck')
    expect(b.canonicalGitRemote).toBe('github.com/butterngo/choda-deck')
    expect(a.repoRelativeWorkspacePath).toBe('')
    expect(b.repoRelativeWorkspacePath).toBe('docs')
    expect(a.localFallbackKey).toBeNull()
    expect(b.localFallbackKey).toBeNull()
  })

  it('worktree case: workspaces in main checkout and worktree share identity', () => {
    const sharedCommonDir = path.resolve('/repos/choda-deck/.git')
    const mainTop = path.resolve('/repos/choda-deck')
    const wtTop = path.resolve('/repos/choda-deck.worktrees/feat-x')

    const git = fakeGit({
      gitCommonDir: () => sharedCommonDir,
      showToplevel: (cwd) => (cwd.includes('worktrees') ? wtTop : mainTop),
      getRemoteOrigin: () => 'git@github.com:butterngo/choda-deck.git'
    })

    const main = computeWorkspaceIdentity(
      { id: 'main', cwd: path.join(mainTop, 'src') },
      'choda-deck',
      git
    )
    const wt = computeWorkspaceIdentity(
      { id: 'feat-x', cwd: path.join(wtTop, 'src') },
      'choda-deck',
      git
    )

    expect(main.canonicalGitRemote).toBe(wt.canonicalGitRemote)
    expect(main.repoRelativeWorkspacePath).toBe('src')
    expect(wt.repoRelativeWorkspacePath).toBe('src')
  })

  it('non-git case: workspace outside any git repo falls back to local key', () => {
    const git = fakeGit({})
    const id = computeWorkspaceIdentity({ id: 'sandbox', cwd: '/tmp/scratch' }, 'p', git)
    expect(id.canonicalGitRemote).toBeNull()
    expect(id.repoRelativeWorkspacePath).toBeNull()
    expect(id.localFallbackKey).toBe('local:p:sandbox')
  })

  it('git folder without origin remote falls back to local key', () => {
    const git = fakeGit({
      gitCommonDir: () => path.resolve('/repo/.git'),
      showToplevel: () => path.resolve('/repo'),
      getRemoteOrigin: () => null
    })
    const id = computeWorkspaceIdentity({ id: 'w', cwd: '/repo' }, 'p', git)
    expect(id.localFallbackKey).toBe('local:p:w')
  })

  it('resolves relative `--git-common-dir` returned by older Windows git', () => {
    const cwd = path.resolve('/repo/sub')
    const git = fakeGit({
      gitCommonDir: () => '../.git',
      showToplevel: () => path.resolve('/repo'),
      getRemoteOrigin: (gitCwd) => {
        expect(path.resolve(gitCwd)).toBe(path.resolve('/repo'))
        return 'https://github.com/u/r.git'
      }
    })
    const id = computeWorkspaceIdentity({ id: 'w', cwd }, 'p', git)
    expect(id.canonicalGitRemote).toBe('github.com/u/r')
    expect(id.repoRelativeWorkspacePath).toBe('sub')
  })

  it('normalises Windows backslashes to forward slashes in repo-relative path', () => {
    const repoRoot = path.resolve('/repo')
    const git = fakeGit({
      gitCommonDir: () => path.join(repoRoot, '.git'),
      showToplevel: () => repoRoot,
      getRemoteOrigin: () => 'git@github.com:u/r.git'
    })
    const id = computeWorkspaceIdentity(
      { id: 'w', cwd: path.join(repoRoot, 'a', 'b', 'c') },
      'p',
      git
    )
    expect(id.repoRelativeWorkspacePath).toBe('a/b/c')
    expect(id.repoRelativeWorkspacePath).not.toMatch(/\\/)
  })
})

describe('computeWorkspaceIdentities — caching', () => {
  it('caches the remote URL per logical repo root across workspaces', () => {
    const repoRoot = path.resolve('/repo')
    let remoteCalls = 0
    const git = fakeGit({
      gitCommonDir: () => path.join(repoRoot, '.git'),
      showToplevel: () => repoRoot,
      getRemoteOrigin: () => {
        remoteCalls++
        return 'git@github.com:u/r.git'
      }
    })

    const ids = computeWorkspaceIdentities(
      [
        { id: 'a', cwd: path.join(repoRoot, 'a') },
        { id: 'b', cwd: path.join(repoRoot, 'b') },
        { id: 'c', cwd: path.join(repoRoot, 'c') }
      ],
      () => 'p',
      git
    )

    expect(ids).toHaveLength(3)
    expect(remoteCalls).toBe(1)
  })
})
