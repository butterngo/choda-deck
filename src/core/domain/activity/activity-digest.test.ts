import { describe, it, expect } from 'vitest'
import { computeTranscriptDigest, localDate, resolveWorkspace } from './activity-digest'

// TASK-2150 — every fixture is built so a plausible wrong implementation yields a
// different number than the right one (e.g. UTC bucketing, counting sidechains).

const DATE = '2026-09-25'
const WS = 'C:/ws'

/** 10:00 local (UTC+7) on DATE is 03:00Z. */
function at(localHhMm: string): string {
  const [h, m] = localHhMm.split(':').map(Number)
  return new Date(Date.UTC(2026, 8, 25, h - 7, m)).toISOString()
}

function prompt(text: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: ts,
    sessionId: 'S1',
    cwd: WS,
    message: { role: 'user', content: text },
    ...extra
  })
}

function assistant(
  ts: string,
  extra: Record<string, unknown> = {},
  content: unknown[] = []
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    sessionId: 'S1',
    cwd: WS,
    message: { role: 'assistant', content },
    ...extra
  })
}

function digest(lines: string[], workspaces = [WS]) {
  return computeTranscriptDigest({ date: DATE, files: [lines.join('\n')], workspaces })
}

describe('localDate', () => {
  it('buckets by the given tz, not UTC', () => {
    expect(localDate(Date.parse('2026-09-24T17:01:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-09-25')
    expect(localDate(Date.parse('2026-09-24T16:59:00Z'), 'Asia/Ho_Chi_Minh')).toBe('2026-09-24')
  })
})

describe('resolveWorkspace', () => {
  it('matches the longest registered prefix, case- and slash-insensitively', () => {
    expect(resolveWorkspace('C:\\WS\\docs', ['C:/ws', 'C:/ws/docs'])).toBe('c:/ws/docs')
    expect(resolveWorkspace('C:/wsx', ['C:/ws'])).toBeNull()
  })
})

describe('computeTranscriptDigest — TASK-2150', () => {
  it('AC-1: counts only rows inside the local day (16:59Z is the previous day in UTC+7)', () => {
    const d = digest([
      prompt('first prompt of the night', '2026-09-24T16:59:00Z'),
      prompt('first prompt of the day', '2026-09-24T17:01:00Z')
    ])
    expect(d.metrics.prompts).toBe(1)
  })

  it('AC-2: counts unparseable lines and non user/assistant types without interpreting them', () => {
    const d = digest([
      '{not json',
      JSON.stringify({ type: 'pr-link', timestamp: at('10:00'), sessionId: 'S1' }),
      prompt('a real prompt here', at('10:01'))
    ])
    expect(d.sources.badRows).toBe(1)
    expect(d.sources.unknownTypes).toBe(1)
    expect(d.metrics.prompts).toBe(1)
  })

  it('AC-3: sidechain rows are not prompts but their tool_use counts in toolMix', () => {
    const d = digest([
      prompt('subagent instructions text', at('10:00'), { isSidechain: true }),
      assistant(at('10:01'), { isSidechain: true }, [{ type: 'tool_use', name: 'Bash', input: {} }])
    ])
    expect(d.metrics.prompts).toBe(0)
    expect(d.metrics.toolMix.Bash).toBe(1)
  })

  it('AC-4: confirmation turns are whole-prompt matches only', () => {
    const d = digest([
      prompt('okay', at('10:00')),
      prompt('y', at('10:01')),
      prompt('fix the null check in X', at('10:02'))
    ])
    expect(d.metrics.confirmationTurns).toBe(2)
    expect(d.metrics.confirmationRate).toBe(0.67)
  })

  it('AC-5: a run overlapped by another session’s prompt counts as run but not as wait', () => {
    const d = digest([
      prompt('session A asks something', at('10:00'), { sessionId: 'A' }),
      assistant(at('10:02'), { sessionId: 'A' }),
      assistant(at('10:10'), { sessionId: 'A' }),
      prompt('session B asks something', at('10:05'), { sessionId: 'B' }),
      assistant(at('10:06'), { sessionId: 'B' })
    ])
    expect(d.metrics.claudeRunMinutes).toBe(11)
    expect(d.metrics.waitMinutes).toBe(1)
  })

  it('AC-6: subdirs and case variants stay in one workspace; unregistered cwds are unresolved', () => {
    const d = digest([
      prompt('work in the reports folder', at('10:00'), { cwd: 'C:\\ws\\docs\\reports' }),
      prompt('work at the workspace root', at('10:01'), { cwd: 'C:/WS' }),
      prompt('work somewhere unregistered', at('10:02'), { cwd: 'C:/tmp/x' })
    ])
    expect(d.metrics.projectSwitches).toBe(1)
    expect(d.metrics.unresolvedPrompts).toBe(1)
  })

  it('tool_result user rows and meta rows are not prompts', () => {
    const d = digest([
      prompt('', at('10:00'), { message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      prompt('caveat meta text', at('10:01'), { isMeta: true })
    ])
    expect(d.metrics.prompts).toBe(0)
  })

  it('sums token usage, collects versions, and orders output deterministically', () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100
    }
    const d = digest([
      prompt('please do the thing', at('10:00'), { version: '2.1.281' }),
      assistant(at('10:01'), { message: { content: [], usage } }),
      prompt('please do the thing', at('10:30'))
    ])
    expect(d.metrics.tokens).toEqual({ in: 12, out: 5, cacheRead: 100 })
    expect(d.claudeCodeVersions).toEqual(['2.1.281'])
    expect(d.metrics.repeatedPrompts).toEqual([{ normalized: 'please do the thing', count: 2 }])
    expect(d.metrics.byProject).toEqual([
      { workspace: 'c:/ws', prompts: 2, activeMinutes: 10, tokens: 17 }
    ])
  })
})
