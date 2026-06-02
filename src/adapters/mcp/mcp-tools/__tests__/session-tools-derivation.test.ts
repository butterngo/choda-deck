import { describe, it, expect } from 'vitest'
import { resolveCommits, resolveResumePoint } from '../session-tools'
import type { GitOps } from '../../../../core/domain/knowledge-git'
import type { TranscriptOps, ReadResumePointOpts } from '../../../../core/domain/session-transcript'
import type { Session } from '../../../../core/domain/task-types'

// TASK-985 (ADR-031 Tier 1) — resolveCommits is the AI-wins merge gate for
// handoff.commits. The git wrapper (commitsInWindow) is a thin stub here per the
// "pure-heuristic-core-thin-git-wrapper" ADR; these tests pin the gating + window logic.

const SESSION: Session = {
  id: 'SESSION-1',
  projectId: 'proj',
  workspaceId: 'main',
  taskId: 'TASK-985',
  startedAt: '2026-06-02T05:00:00.000Z',
  endedAt: null,
  status: 'active',
  ccSessionId: null,
  handoff: null
} as Session

function makeGit(overrides: Partial<GitOps> = {}): GitOps {
  return {
    getHeadSha: () => '',
    countCommitsSince: () => 0,
    isAncestor: () => false,
    filesInCommit: () => [],
    commitsInWindow: () => [],
    ...overrides
  }
}

function makeSvc(session: Session | null, cwd: string | null): Parameters<typeof resolveCommits>[0] {
  return {
    getSession: async () => session,
    getProject: async () => (cwd === null ? null : ({ id: 'proj', cwd } as never))
  } as unknown as Parameters<typeof resolveCommits>[0]
}

describe('resolveCommits — TASK-985 commit derivation (AI-wins)', () => {
  it('AI-provided commits win — no derivation, git untouched', async () => {
    let called = false
    const git = makeGit({
      commitsInWindow: () => {
        called = true
        return ['deadbee should-not-be-used']
      }
    })
    const out = await resolveCommits(makeSvc(SESSION, 'C:/repo'), git, 'SESSION-1', [
      'abc1234 TASK-985 real commit'
    ])
    expect(out).toEqual(['abc1234 TASK-985 real commit'])
    expect(called).toBe(false)
  })

  it('omitted commits → derives from the session window', async () => {
    let seenSince: string | undefined
    let seenGrep: string | undefined
    const git = makeGit({
      commitsInWindow: (_cwd, since, grep) => {
        seenSince = since
        seenGrep = grep
        return ['abc1234 TASK-985 derived', 'def5678 TASK-985 another']
      }
    })
    const out = await resolveCommits(makeSvc(SESSION, 'C:/repo'), git, 'SESSION-1', undefined)
    expect(out).toEqual(['abc1234 TASK-985 derived', 'def5678 TASK-985 another'])
    expect(seenSince).toBe('2026-06-02T05:00:00.000Z') // window = session.startedAt
    expect(seenGrep).toBe('TASK-985') // bound task disambiguates parallel sessions
  })

  it('empty AI array is treated as omitted → derives', async () => {
    const git = makeGit({ commitsInWindow: () => ['abc1234 derived'] })
    const out = await resolveCommits(makeSvc(SESSION, 'C:/repo'), git, 'SESSION-1', [])
    expect(out).toEqual(['abc1234 derived'])
  })

  it('no commits in window → returns the original (undefined), not an empty array', async () => {
    const git = makeGit({ commitsInWindow: () => [] })
    const out = await resolveCommits(makeSvc(SESSION, 'C:/repo'), git, 'SESSION-1', undefined)
    expect(out).toBeUndefined()
  })

  it('session not found → passes provided through, no git call', async () => {
    let called = false
    const git = makeGit({
      commitsInWindow: () => {
        called = true
        return ['x']
      }
    })
    const out = await resolveCommits(makeSvc(null, 'C:/repo'), git, 'SESSION-MISSING', undefined)
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })

  it('project has no cwd → passes provided through, no git call', async () => {
    let called = false
    const git = makeGit({
      commitsInWindow: () => {
        called = true
        return ['x']
      }
    })
    const out = await resolveCommits(makeSvc(SESSION, null), git, 'SESSION-1', undefined)
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })

  it('session with no bound task → derives by window only (no grep filter)', async () => {
    let seenGrep: string | undefined = 'untouched'
    const git = makeGit({
      commitsInWindow: (_cwd, _since, grep) => {
        seenGrep = grep
        return ['abc1234 untagged commit']
      }
    })
    const taskless = { ...SESSION, taskId: null } as Session
    const out = await resolveCommits(makeSvc(taskless, 'C:/repo'), git, 'SESSION-1', undefined)
    expect(out).toEqual(['abc1234 untagged commit'])
    expect(seenGrep).toBeUndefined()
  })
})

function makeTranscript(fn: (opts: ReadResumePointOpts) => string | null): TranscriptOps {
  return { readResumePoint: fn }
}

describe('resolveResumePoint — TASK-985 resumePoint derivation (AI-wins)', () => {
  it('AI-provided resumePoint wins — transcript untouched', async () => {
    let called = false
    const t = makeTranscript(() => {
      called = true
      return 'derived'
    })
    const out = await resolveResumePoint(makeSvc(SESSION, 'C:/repo'), t, 'SESSION-1', 'I stopped here')
    expect(out).toBe('I stopped here')
    expect(called).toBe(false)
  })

  it('blank/whitespace resumePoint is treated as omitted → derives', async () => {
    const t = makeTranscript(() => 'derived point')
    const out = await resolveResumePoint(makeSvc(SESSION, 'C:/repo'), t, 'SESSION-1', '   ')
    expect(out).toBe('derived point')
  })

  it('omitted → derives, forwarding cwd + ccSessionId + window', async () => {
    let seen: ReadResumePointOpts | null = null
    const withCc = { ...SESSION, ccSessionId: 'cc-uuid-123' } as Session
    const t = makeTranscript((opts) => {
      seen = opts
      return 'last assistant text'
    })
    const out = await resolveResumePoint(makeSvc(withCc, 'C:/repo'), t, 'SESSION-1', undefined)
    expect(out).toBe('last assistant text')
    expect(seen!.cwd).toBe('C:/repo')
    expect(seen!.ccSessionId).toBe('cc-uuid-123')
    expect(seen!.startedAt).toBe('2026-06-02T05:00:00.000Z')
  })

  it('transcript miss → falls back to provided (undefined), no wrong value', async () => {
    const t = makeTranscript(() => null)
    const out = await resolveResumePoint(makeSvc(SESSION, 'C:/repo'), t, 'SESSION-1', undefined)
    expect(out).toBeUndefined()
  })

  it('no cwd → passes provided through, transcript untouched', async () => {
    let called = false
    const t = makeTranscript(() => {
      called = true
      return 'x'
    })
    const out = await resolveResumePoint(makeSvc(SESSION, null), t, 'SESSION-1', undefined)
    expect(out).toBeUndefined()
    expect(called).toBe(false)
  })
})
