import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Task } from '../task-types'
import type { PreflightGitFns } from './queue-start-preflight'
import { validateQueueStartPreflight } from './queue-start-preflight'

const VALID_BODY = [
  '## Context',
  'Some context.',
  '',
  '## Acceptance',
  '- [ ] Tests pass: `pnpm test src/foo.test.ts`',
  '',
  '## File Pointers',
  '- `src/foo.ts:1-10` — module entry',
  '- `src/new-file.ts` — to be created (no range)',
  '',
  '## Scope',
  '~1h',
  ''
].join('\n')

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: 'p',
    parentTaskId: null,
    title: `task ${id}`,
    status: 'READY',
    priority: 'high',
    labels: ['auto-safe'],
    dueDate: null,
    pinned: false,
    filePath: null,
    body: VALID_BODY,
    blockedBy: [],
    createdAt: '2026-05-13T00:00:00Z',
    updatedAt: '2026-05-13T00:00:00Z',
    ...overrides
  }
}

interface FakeFsState {
  existingPaths: Set<string>
  writableDirs: Set<string>
  refMap: Map<string, string>
  branches: Set<string>
  ghOk: boolean
  filesAtSha: Set<string>
}

function makeFns(state: FakeFsState): PreflightGitFns {
  return {
    pathExists: async (p) => state.existingPaths.has(p),
    isWritable: async (p) => state.writableDirs.has(p),
    resolveRef: async (_cwd, ref) => state.refMap.get(ref) ?? null,
    branchExists: async (_cwd, b) => state.branches.has(b),
    ghAuthStatus: async () => state.ghOk,
    fileExistsAtSha: async (_cwd, sha, rel) => state.filesAtSha.has(`${sha}:${rel}`)
  }
}

function happyState(): FakeFsState {
  return {
    existingPaths: new Set(['C:/dev/choda-deck.worktrees']),
    writableDirs: new Set(['C:/dev/choda-deck.worktrees']),
    refMap: new Map([['main', 'sha-aaaa']]),
    branches: new Set(),
    ghOk: true,
    filesAtSha: new Set(['sha-aaaa:src/foo.ts'])
  }
}

const baseInput = {
  repoCwd: 'C:/dev/choda-deck',
  baseRef: 'main',
  worktreesParentDir: 'C:/dev/choda-deck.worktrees',
  branchPrefix: 'auto/'
}

describe('validateQueueStartPreflight', () => {
  it('happy path — all checks pass, ok=true, baseSha returned', async () => {
    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100'), makeTask('TASK-101')],
      fns: makeFns(happyState())
    })

    expect(result.ok).toBe(true)
    expect(result.baseSha).toBe('sha-aaaa')
    expect(result.globalErrors).toEqual([])
    expect(result.failures).toEqual([])
  })

  it('global error: baseRef unresolvable → ok=false, baseSha=null', async () => {
    const state = happyState()
    state.refMap.clear()

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.baseSha).toBeNull()
    expect(result.globalErrors).toContain('baseRef "main" is unresolvable in C:/dev/choda-deck')
  })

  it('global error: worktrees parent dir missing', async () => {
    const state = happyState()
    state.existingPaths.delete('C:/dev/choda-deck.worktrees')

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.globalErrors.some((e) => e.includes('does not exist'))).toBe(true)
  })

  it('global error: worktrees parent dir not writable', async () => {
    const state = happyState()
    state.writableDirs.clear()

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.globalErrors.some((e) => e.includes('not writable'))).toBe(true)
  })

  it('global error: gh auth missing', async () => {
    const state = happyState()
    state.ghOk = false

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.globalErrors.some((e) => e.includes('gh auth'))).toBe(true)
  })

  it('per-task fail: orphan worktree path exists for that task', async () => {
    const state = happyState()
    state.existingPaths.add(path.join('C:/dev/choda-deck.worktrees', 'TASK-100'))

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100'), makeTask('TASK-101')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].taskId).toBe('TASK-100')
    expect(result.failures[0].reasons.some((r) => r.includes('worktree path already exists'))).toBe(true)
  })

  it('per-task fail: branch auto/<taskId> already exists', async () => {
    const state = happyState()
    state.branches.add('auto/TASK-100')

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0].reasons.some((r) => r.includes('branch already exists'))).toBe(true)
  })

  it('per-task fail: missing auto-safe label', async () => {
    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100', { labels: [] })],
      fns: makeFns(happyState())
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0].reasons.some((r) => r.includes('missing label "auto-safe"'))).toBe(true)
  })

  it('per-task fail: structural — missing ## Acceptance section', async () => {
    const body = '## Context\nfoo\n\n## File Pointers\n- `src/foo.ts:1-10`\n\n## Scope\n~1h\n'

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100', { body })],
      fns: makeFns(happyState())
    })

    expect(result.ok).toBe(false)
    expect(result.failures[0].reasons.some((r) => r.startsWith('structural:'))).toBe(true)
  })

  it('per-task fail: File Pointer with range references missing file at baseSha', async () => {
    const state = happyState()
    state.filesAtSha.clear() // src/foo.ts:1-10 won't be found

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(
      result.failures[0].reasons.some((r) =>
        r.includes('File Pointer with range references missing file')
      )
    ).toBe(true)
  })

  it('File Pointer without range is accepted as new file (no failure)', async () => {
    const bodyNewFileOnly = [
      '## Context',
      'foo',
      '',
      '## Acceptance',
      '- [ ] `pnpm test`',
      '',
      '## File Pointers',
      '- `src/never-existed.ts` — new file, no range',
      '',
      '## Scope',
      '~1h',
      ''
    ].join('\n')

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100', { body: bodyNewFileOnly })],
      fns: makeFns(happyState())
    })

    expect(result.ok).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('aggregates failures across tasks — 1 fail + 1 pass = ok=false, failures has 1', async () => {
    const state = happyState()
    state.branches.add('auto/TASK-101')

    const result = await validateQueueStartPreflight({
      ...baseInput,
      tasks: [makeTask('TASK-100'), makeTask('TASK-101'), makeTask('TASK-102')],
      fns: makeFns(state)
    })

    expect(result.ok).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].taskId).toBe('TASK-101')
  })
})
