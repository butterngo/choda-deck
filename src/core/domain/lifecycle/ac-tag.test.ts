import { describe, it, expect } from 'vitest'
import { acTag, methodAllowed, refRequired } from './ac-tag'

describe('acTag (TASK-2595)', () => {
  it('AC-8: reads a case-insensitive tag and rejects a word that only starts like one', () => {
    expect(acTag('x — Test')).toBe('test')
    expect(acTag('x — tested')).toBeNull()
  })

  it('reads each of the four tags', () => {
    expect(acTag('`pnpm run lint` exits 0 — command')).toBe('command')
    expect(acTag('the file contains `## Sequence` — grep')).toBe('grep')
    expect(acTag('Butter sees the card — human')).toBe('human')
  })

  it('needs the em dash with a space before it, and the tag last', () => {
    expect(acTag('x - test')).toBeNull()
    expect(acTag('x—test')).toBeNull()
    expect(acTag('x — test and more')).toBeNull()
    expect(acTag('no tag at all')).toBeNull()
  })

  it('tolerates trailing whitespace', () => {
    expect(acTag('x — test  ')).toBe('test')
  })
})

describe('methodAllowed / refRequired (TASK-2595)', () => {
  it('follows the tag table', () => {
    expect(methodAllowed('test', 'test')).toBe(true)
    expect(methodAllowed('test', 'command')).toBe(false)
    expect(methodAllowed('command', 'test')).toBe(true)
    expect(methodAllowed('command', 'grep')).toBe(false)
    expect(methodAllowed('grep', 'command')).toBe(true)
    expect(methodAllowed('human', 'manual')).toBe(true)
    expect(methodAllowed('human', 'test')).toBe(false)
    expect(methodAllowed('test', undefined)).toBe(false)
  })

  it('an untagged AC accepts any method, or none', () => {
    expect(methodAllowed(null, undefined)).toBe(true)
    expect(methodAllowed(null, 'grep')).toBe(true)
  })

  it('a ref is required for test, command and grep, not for human or untagged', () => {
    expect(refRequired('test')).toBe(true)
    expect(refRequired('command')).toBe(true)
    expect(refRequired('grep')).toBe(true)
    expect(refRequired('human')).toBe(false)
    expect(refRequired(null)).toBe(false)
  })
})
