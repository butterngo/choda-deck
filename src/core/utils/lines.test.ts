import { describe, expect, it } from 'vitest'
import { splitLines } from './lines'

describe('splitLines', () => {
  it('splits LF + CRLF endings to the same line list', () => {
    expect(splitLines('a\nb\r\nc')).toEqual(['a', 'b', 'c'])
  })

  it('returns a single empty string for empty input (matches split contract)', () => {
    expect(splitLines('')).toEqual([''])
  })

  it('preserves trailing empty line after final newline', () => {
    expect(splitLines('a\n')).toEqual(['a', ''])
    expect(splitLines('a\r\n')).toEqual(['a', ''])
  })

  it('handles mixed-ending content without leaving stray \\r', () => {
    const mixed = 'header\r\nbody1\nbody2\r\nfooter'
    expect(splitLines(mixed)).toEqual(['header', 'body1', 'body2', 'footer'])
  })
})
