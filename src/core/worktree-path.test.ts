import { describe, it, expect } from 'vitest'
import { isLikelyWorktreePath } from './worktree-path'

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
