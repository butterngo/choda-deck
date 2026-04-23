import { describe, it, expect } from 'vitest'
import { stripToolCallLeak } from './sanitize'

describe('stripToolCallLeak', () => {
  it('returns text unchanged when no leak markers present', () => {
    const clean = 'TASK-550 DONE — session checkpoint shipped. Next: TASK-539.'
    expect(stripToolCallLeak(clean)).toBe(clean)
  })

  it('truncates at </resumePoint> closing tag leak', () => {
    const dirty = 'TASK-550 DONE — next TASK-539.</resumePoint>\n<parameter name="decisions">[]'
    expect(stripToolCallLeak(dirty)).toBe('TASK-550 DONE — next TASK-539.')
  })

  it('truncates at stray <parameter name leak', () => {
    const dirty = 'Decided X.\n<parameter name="foo">bar</parameter>'
    expect(stripToolCallLeak(dirty)).toBe('Decided X.')
  })

  it('truncates at <invoke> leak', () => {
    const dirty = 'Decided Y.<invoke name="tool">args</invoke>'
    expect(stripToolCallLeak(dirty)).toBe('Decided Y.')
  })

  it('truncates at <function_calls> leak', () => {
    const dirty = 'Decided Z.<function_calls><invoke></invoke></function_calls>'
    expect(stripToolCallLeak(dirty)).toBe('Decided Z.')
  })

  it('truncates at partial closing tag at end of string', () => {
    const dirty = 'Decided — next session pick TASK-540 (Role prompts).</res'
    expect(stripToolCallLeak(dirty)).toBe('Decided — next session pick TASK-540 (Role prompts).')
  })

  it('returns empty string for null/undefined/empty', () => {
    expect(stripToolCallLeak(null)).toBe('')
    expect(stripToolCallLeak(undefined)).toBe('')
    expect(stripToolCallLeak('')).toBe('')
  })

  it('trims trailing whitespace after truncation', () => {
    const dirty = 'Decision.\n\n  </resumePoint>'
    expect(stripToolCallLeak(dirty)).toBe('Decision.')
  })
})
