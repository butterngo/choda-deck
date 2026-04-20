import { describe, it, expect } from 'vitest'
import { quoteArg, buildCommandLine } from './spawn-utils'

describe('quoteArg', () => {
  it('returns arg unchanged when no cmd metacharacters', () => {
    expect(quoteArg('simple')).toBe('simple')
    expect(quoteArg('--flag')).toBe('--flag')
    expect(quoteArg('Read,Grep,Glob')).toBe('Read,Grep,Glob')
  })

  it('wraps args containing whitespace in double quotes', () => {
    expect(quoteArg('has space')).toBe('"has space"')
  })

  it('wraps args with cmd metacharacters', () => {
    expect(quoteArg('Bash(git *)')).toBe('"Bash(git *)"')
    expect(quoteArg('a&b')).toBe('"a&b"')
    expect(quoteArg('x|y')).toBe('"x|y"')
  })

  it('escapes inner double quotes', () => {
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""')
  })
})

describe('buildCommandLine', () => {
  it('joins executable + quoted args with spaces', () => {
    expect(buildCommandLine('claude', ['-p', '--model', 'sonnet'])).toBe('claude -p --model sonnet')
  })

  it('quotes executable paths containing spaces', () => {
    const line = buildCommandLine('C:\\Program Files\\claude.cmd', ['-p'])
    expect(line).toBe('"C:\\Program Files\\claude.cmd" -p')
  })

  it('quotes args with metacharacters', () => {
    const line = buildCommandLine('claude', ['--allowed-tools', 'Bash(git *)'])
    expect(line).toBe('claude --allowed-tools "Bash(git *)"')
  })
})
