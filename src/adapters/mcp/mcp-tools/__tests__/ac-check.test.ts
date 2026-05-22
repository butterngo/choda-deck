import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../../../../core/domain/sqlite-task-service'
import { register, type AcCheckDeps } from '../ac-check'
import {
  assertNarrowDiff,
  findAcItems,
  flipAcCheckbox
} from '../../../../core/domain/lifecycle/ac-check'
import {
  AcAlreadyCheckedError,
  AcIndexOutOfRangeError,
  BodyLockViolationError
} from '../../../../core/domain/lifecycle/errors'

interface RegisteredTool {
  name: string
  handler: (args?: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>
  }>
}

function makeServerStub(): {
  tools: RegisteredTool[]
  registerTool: (name: string, _meta: unknown, handler: RegisteredTool['handler']) => void
} {
  const tools: RegisteredTool[] = []
  return {
    tools,
    registerTool: (name, _meta, handler) => {
      tools.push({ name, handler })
    }
  }
}

const TEST_DB = path.join(__dirname, '__test-ac-check__.db')

const SAMPLE_BODY = `## Context

Implementation note.

## Acceptance

- [ ] First criterion — runs \`pnpm run lint\`
- [ ] Second criterion
- [x] Already checked
- [ ] Fourth criterion

## Test Plan

- [ ] this is in Test Plan, not Acceptance
`

describe('findAcItems (pure)', () => {
  it('returns AC items in order with checked flag and trimmed text', () => {
    const items = findAcItems(SAMPLE_BODY)
    expect(items).toHaveLength(4)
    expect(items[0].checked).toBe(false)
    expect(items[0].text).toMatch(/^First criterion/)
    expect(items[2].checked).toBe(true)
    expect(items[2].text).toBe('Already checked')
  })

  it('returns [] when body has no Acceptance section', () => {
    expect(findAcItems('## Context only\n\nNo acceptance here.')).toEqual([])
  })

  it('stops at the next `## ` heading — does not pick up Test Plan items', () => {
    const items = findAcItems(SAMPLE_BODY)
    expect(items.every((i) => !i.text.includes('Test Plan'))).toBe(true)
  })

  it('skips checkbox-like lines inside fenced code blocks', () => {
    const body = `## Acceptance

- [ ] real item

\`\`\`md
- [ ] fake item inside fence
\`\`\`

- [ ] another real item
`
    const items = findAcItems(body)
    expect(items.map((i) => i.text)).toEqual(['real item', 'another real item'])
  })
})

describe('flipAcCheckbox (pure)', () => {
  it('flips the unchecked target only — body length unchanged', () => {
    const { newBody, item } = flipAcCheckbox(SAMPLE_BODY, 'TASK-T', 1)
    expect(item.text).toBe('Second criterion')
    expect(newBody.length).toBe(SAMPLE_BODY.length)
    // first item still unchecked, second now checked, third already-checked still checked
    const items = findAcItems(newBody)
    expect(items[0].checked).toBe(false)
    expect(items[1].checked).toBe(true)
    expect(items[2].checked).toBe(true)
  })

  it('throws AcIndexOutOfRangeError when index < 0 or >= count', () => {
    expect(() => flipAcCheckbox(SAMPLE_BODY, 'TASK-T', 99)).toThrowError(AcIndexOutOfRangeError)
    expect(() => flipAcCheckbox(SAMPLE_BODY, 'TASK-T', -1)).toThrowError(AcIndexOutOfRangeError)
  })

  it('throws AcAlreadyCheckedError on a checked item', () => {
    expect(() => flipAcCheckbox(SAMPLE_BODY, 'TASK-T', 2)).toThrowError(AcAlreadyCheckedError)
  })
})

describe('assertNarrowDiff (safety net)', () => {
  it('passes when the only change is ` ` → `x` at the expected offset', () => {
    const a = 'foo [ ] bar'
    const b = 'foo [x] bar'
    expect(() => assertNarrowDiff(a, b, 4, 'TASK-T')).not.toThrow()
  })

  it('rejects length changes', () => {
    expect(() => assertNarrowDiff('foo [ ] bar', 'foo [x] barz', 4, 'TASK-T')).toThrowError(
      BodyLockViolationError
    )
  })

  it('rejects edits outside the target bracket', () => {
    const a = 'foo [ ] bar'
    const b = 'FOO [x] bar' // mutates leading "foo"
    expect(() => assertNarrowDiff(a, b, 4, 'TASK-T')).toThrowError(BodyLockViolationError)
  })

  it('rejects ` ` → non-x replacements at the right offset', () => {
    const a = 'foo [ ] bar'
    const b = 'foo [Y] bar'
    expect(() => assertNarrowDiff(a, b, 4, 'TASK-T')).toThrowError(BodyLockViolationError)
  })
})

describe('ac_check MCP tool — integration via SqliteTaskService', () => {
  let svc: SqliteTaskService
  let server: ReturnType<typeof makeServerStub>

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
    svc = new SqliteTaskService(TEST_DB)
    svc.ensureProject('proj-ac', 'AC Project', 'C:/tmp/proj-ac')
    svc.addWorkspace('proj-ac', 'ws-main', 'Main', 'C:/tmp/proj-ac')
    svc.createTask({
      id: 'TASK-AC',
      projectId: 'proj-ac',
      title: 'AC test task',
      priority: 'medium',
      body: SAMPLE_BODY
    })
    server = makeServerStub()
    register(server as unknown as Parameters<typeof register>[0], svc as unknown as AcCheckDeps)
  })

  afterEach(() => {
    svc.close()
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  })

  async function callAcCheck(
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const tool = server.tools.find((t) => t.name === 'ac_check')
    if (!tool) throw new Error('ac_check not registered')
    const res = await tool.handler(args)
    return JSON.parse(res.content[0].text) as Record<string, unknown>
  }

  it('happy path: flips AC + emits observation atomically when session is active', async () => {
    const session = svc.startSession({ projectId: 'proj-ac', taskId: 'TASK-AC', workspaceId: 'ws-main' })

    const out = await callAcCheck({
      taskId: 'TASK-AC',
      acIndex: 0,
      evidence: 'pnpm run lint exits 0',
      cwd: 'C:/tmp/proj-ac'
    })

    expect(out.sessionId).toBe(session.session.id)
    expect(out.eventId).toMatch(/^EVT-/)

    // Body flipped exactly at index 0
    const after = svc.getTask('TASK-AC')!
    const items = findAcItems(after.body ?? '')
    expect(items[0].checked).toBe(true)
    expect(items[1].checked).toBe(false)

    // One ac_check observation event landed
    const events = svc.listSessionEvents(session.session.id, 'observation')
    expect(events).toHaveLength(1)
    const payload = JSON.parse(events[0].payloadJson ?? '{}')
    expect(payload.kind).toBe('ac_check')
    expect(payload.taskId).toBe('TASK-AC')
    expect(payload.acIndex).toBe(0)
    expect(payload.evidence).toBe('pnpm run lint exits 0')
    expect(payload.text).toMatch(/^First criterion/)
  })

  it('returns NO_ACTIVE_SESSION error when no session is active for the workspace', async () => {
    const out = await callAcCheck({
      taskId: 'TASK-AC',
      acIndex: 0,
      evidence: 'x',
      cwd: 'C:/tmp/proj-ac'
    })
    expect(out.error).toBe('NO_ACTIVE_SESSION')
    // Body NOT updated
    const items = findAcItems(svc.getTask('TASK-AC')!.body ?? '')
    expect(items[0].checked).toBe(false)
  })

  it('returns AC_INDEX_OUT_OF_RANGE when index too large', async () => {
    svc.startSession({ projectId: 'proj-ac', taskId: 'TASK-AC', workspaceId: 'ws-main' })
    const out = await callAcCheck({
      taskId: 'TASK-AC',
      acIndex: 99,
      evidence: 'x',
      cwd: 'C:/tmp/proj-ac'
    })
    expect(out.error).toBe('AC_INDEX_OUT_OF_RANGE')
  })

  it('returns AC_ALREADY_CHECKED on double-check', async () => {
    svc.startSession({ projectId: 'proj-ac', taskId: 'TASK-AC', workspaceId: 'ws-main' })
    const out = await callAcCheck({
      taskId: 'TASK-AC',
      acIndex: 2,
      evidence: 'x',
      cwd: 'C:/tmp/proj-ac'
    })
    expect(out.error).toBe('AC_ALREADY_CHECKED')
  })

  it('rolls back the body write when the event INSERT fails (atomic)', async () => {
    const session = svc.startSession({ projectId: 'proj-ac', taskId: 'TASK-AC', workspaceId: 'ws-main' })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internalEvents = (svc as any).sessionEvents
    const origCreate = internalEvents.create.bind(internalEvents)
    internalEvents.create = (): never => {
      throw new Error('simulated event INSERT failure')
    }

    await expect(
      callAcCheck({
        taskId: 'TASK-AC',
        acIndex: 1,
        evidence: 'x',
        cwd: 'C:/tmp/proj-ac'
      })
    ).rejects.toThrow('simulated event INSERT failure')

    internalEvents.create = origCreate

    const items = findAcItems(svc.getTask('TASK-AC')!.body ?? '')
    expect(items[1].checked).toBe(false)
    expect(svc.listSessionEvents(session.session.id, 'observation')).toEqual([])
  })

  it('returns TASK_NOT_FOUND when task does not exist', async () => {
    svc.startSession({ projectId: 'proj-ac', taskId: 'TASK-AC', workspaceId: 'ws-main' })
    const out = await callAcCheck({
      taskId: 'TASK-NOPE',
      acIndex: 0,
      evidence: 'x',
      cwd: 'C:/tmp/proj-ac'
    })
    expect(out.error).toBe('TASK_NOT_FOUND')
  })
})
