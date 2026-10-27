import { describe, it, expect } from 'vitest'
import { checkoutRootFor, isLikelyWorktreePath } from './worktree-path'

describe('checkoutRootFor (TASK-2790)', () => {
  it('a cwd deep inside <home>.worktrees/<name> returns that worktree root', () => {
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\dev\\x.worktrees\\autopilot-TASK-1\\src\\a')).toBe(
      'C:\\dev\\x.worktrees\\autopilot-TASK-1'
    )
  })

  it('a cwd inside the registered checkout, and a cwd elsewhere, both return homeCwd', () => {
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\dev\\x\\docs')).toBe('C:\\dev\\x')
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\tmp')).toBe('C:\\dev\\x')
    // A sibling repo whose name merely starts with the home's name is not one of its worktrees.
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\dev\\x-other.worktrees\\run-a')).toBe('C:\\dev\\x')
  })

  it('another case and forward slashes still map to the worktree', () => {
    expect(checkoutRootFor('C:\\dev\\x', 'C:/DEV/X.worktrees/run-a')).toBe('C:/DEV/X.worktrees/run-a')
  })

  it('the bare .worktrees folder is not a checkout', () => {
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\dev\\x.worktrees')).toBe('C:\\dev\\x')
    expect(checkoutRootFor('C:\\dev\\x', 'C:\\dev\\x.worktrees\\')).toBe('C:\\dev\\x')
  })

  it('POSIX paths map the same way', () => {
    expect(checkoutRootFor('/home/u/repo', '/home/u/repo.worktrees/feat/src')).toBe('/home/u/repo.worktrees/feat')
  })
})

describe('isLikelyWorktreePath', () => {
  it('matches Windows worktree paths', () => {
    expect(
      isLikelyWorktreePath('C:\\dev\\choda-deck.worktrees\\task-686\\docs\\knowledge\\x.md')
    ).toBe(true)
  })

  it('matches POSIX worktree paths', () => {
    expect(isLikelyWorktreePath('/home/user/repo.worktrees/feature/file.md')).toBe(true)
  })

  it('matches case-insensitively', () => {
    expect(isLikelyWorktreePath('C:\\dev\\Repo.Worktrees\\Branch\\x.md')).toBe(true)
  })

  it('matches when .worktrees is the trailing segment', () => {
    expect(isLikelyWorktreePath('C:\\dev\\repo.worktrees')).toBe(true)
  })

  it('matches relative paths starting with .worktrees', () => {
    expect(isLikelyWorktreePath('.worktrees/task-1/x.md')).toBe(true)
  })

  it('rejects main-checkout repo paths', () => {
    expect(isLikelyWorktreePath('C:\\dev\\choda-deck\\docs\\knowledge\\x.md')).toBe(false)
  })

  it('rejects vault / unrelated absolute paths', () => {
    expect(isLikelyWorktreePath('C:\\Users\\butter\\vault\\30-Knowledge\\x.md')).toBe(false)
  })

  it('rejects substrings that only resemble .worktrees', () => {
    expect(isLikelyWorktreePath('C:\\dev\\my.worktreesxyz\\x.md')).toBe(false)
    expect(isLikelyWorktreePath('C:\\dev\\fooworktrees\\x.md')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isLikelyWorktreePath('')).toBe(false)
  })
})
