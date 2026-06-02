import { describe, it, expect } from 'vitest'
import {
  cwdToProjectSlug,
  parseTranscript,
  extractResumePoint,
  type TranscriptRow
} from './session-transcript'

describe('cwdToProjectSlug — TASK-985', () => {
  it('slugs a Windows cwd to the CC project-dir name (verified live)', () => {
    expect(cwdToProjectSlug('C:\\dev\\choda-deck')).toBe('C--dev-choda-deck')
  })

  it('slugs a worktree cwd to its own dir', () => {
    expect(cwdToProjectSlug('C:\\dev\\choda-deck\\.claude-worktrees\\task-985')).toBe(
      'C--dev-choda-deck--claude-worktrees-task-985'
    )
  })
})

describe('parseTranscript — TASK-985', () => {
  it('parses JSONL and skips malformed lines (CRLF-safe)', () => {
    const content = ['{"type":"user"}', 'not json', '', '{"type":"assistant"}'].join('\r\n')
    const rows = parseTranscript(content)
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant'])
  })
})

function asst(blocks: unknown[]): TranscriptRow {
  return { type: 'assistant', message: { role: 'assistant', content: blocks } }
}

describe('extractResumePoint — TASK-985', () => {
  it('returns the last text-bearing assistant turn, trimmed', () => {
    const rows: TranscriptRow[] = [
      asst([{ type: 'text', text: 'first' }]),
      asst([{ type: 'text', text: '  the real last point  ' }])
    ]
    expect(extractResumePoint(rows)).toBe('the real last point')
  })

  it('skips a trailing tool_use-only turn and walks back to the last text', () => {
    const rows: TranscriptRow[] = [
      asst([{ type: 'text', text: 'meaningful narration' }]),
      asst([{ type: 'tool_use', name: 'Bash', input: {} }])
    ]
    expect(extractResumePoint(rows)).toBe('meaningful narration')
  })

  it('joins multiple text blocks in one turn', () => {
    const rows: TranscriptRow[] = [asst([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])]
    expect(extractResumePoint(rows)).toBe('a\nb')
  })

  it('ignores user turns', () => {
    const rows: TranscriptRow[] = [
      asst([{ type: 'text', text: 'assistant said this' }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'user reply' }] } }
    ]
    expect(extractResumePoint(rows)).toBe('assistant said this')
  })

  it('returns null when there is no assistant text', () => {
    expect(extractResumePoint([asst([{ type: 'tool_use', name: 'X', input: {} }])])).toBeNull()
    expect(extractResumePoint([{ type: 'system' }])).toBeNull()
    expect(extractResumePoint([])).toBeNull()
  })
})
