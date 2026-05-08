import { describe, it, expect } from 'vitest'
import { canonicalGitRemote } from './canonical-remote'

describe('canonicalGitRemote', () => {
  it('produces identical canonical key for 6 input forms of the same remote', () => {
    const expected = 'github.com/butterngo/choda-deck'
    const inputs = [
      'git@github.com:butterngo/choda-deck.git',
      'https://github.com/butterngo/choda-deck.git',
      'https://x-access-token:ghp_abc123@github.com/butterngo/choda-deck.git',
      'https://github.com/butterngo/choda-deck',
      'https://github.com/butterngo/choda-deck.git/',
      'https://GITHUB.com/butterngo/choda-deck.git'
    ]
    for (const input of inputs) {
      expect(canonicalGitRemote(input), `failed on: ${input}`).toBe(expected)
    }
  })

  it('preserves path case (case-sensitive server paths)', () => {
    expect(canonicalGitRemote('https://github.com/Butterngo/Choda-Deck.git')).toBe(
      'github.com/Butterngo/Choda-Deck'
    )
  })

  it('handles ssh:// URL form with port', () => {
    expect(canonicalGitRemote('ssh://git@github.com:22/butterngo/choda-deck.git')).toBe(
      'github.com/butterngo/choda-deck'
    )
  })

  it('handles git:// protocol', () => {
    expect(canonicalGitRemote('git://github.com/butterngo/choda-deck.git')).toBe(
      'github.com/butterngo/choda-deck'
    )
  })

  it('handles nested paths (gitlab subgroups)', () => {
    expect(canonicalGitRemote('https://gitlab.com/group/sub/project.git')).toBe(
      'gitlab.com/group/sub/project'
    )
  })

  it('trims surrounding whitespace', () => {
    expect(canonicalGitRemote('  git@github.com:butterngo/choda-deck.git\n')).toBe(
      'github.com/butterngo/choda-deck'
    )
  })

  it('throws on empty input', () => {
    expect(() => canonicalGitRemote('')).toThrow(/empty url/)
    expect(() => canonicalGitRemote('   ')).toThrow(/empty url/)
  })

  it('throws on unparseable input', () => {
    expect(() => canonicalGitRemote('not a url')).toThrow(/cannot parse/)
  })

  it('throws on missing path', () => {
    expect(() => canonicalGitRemote('https://github.com/')).toThrow(/empty path/)
    expect(() => canonicalGitRemote('git@github.com:.git')).toThrow(/empty path/)
  })
})
