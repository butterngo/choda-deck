import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'
import { resolveFocus } from './focus'
import { register } from '../../../adapters/mcp/mcp-tools/focus-board'
import type { InstrumentedServer } from '../../../adapters/mcp/instrumented-server'

// TASK-2686 — the /choda-task-focus tiers over a real SQLite service.

// 2026-10-23 10:00 +07 — planDate 2026-10-23.
const NOW = Date.parse('2026-10-23T03:00:00Z')

let tmp: string
let svc: SqliteTaskService

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
})

afterEach(async () => {
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveFocus', () => {
  it('AC-1: an active session on TASK-A beats a READY high-priority TASK-B (tier session)', async () => {
    await svc.createTask({
      id: 'TASK-A',
      projectId: 'p',
      title: 'A',
      status: 'READY',
      priority: 'low'
    })
    await svc.createTask({
      id: 'TASK-B',
      projectId: 'p',
      title: 'B',
      status: 'READY',
      priority: 'high'
    })
    await svc.startSession({ projectId: 'p', taskId: 'TASK-A' })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.tier).toBe('session')
    expect(f.focus?.id).toBe('TASK-A')
  })

  it('AC-2: with no session, an IN-PROGRESS low-priority task beats a READY critical one', async () => {
    await svc.createTask({
      id: 'TASK-1',
      projectId: 'p',
      title: 'wip',
      status: 'IN-PROGRESS',
      priority: 'low'
    })
    await svc.createTask({
      id: 'TASK-2',
      projectId: 'p',
      title: 'ready',
      status: 'READY',
      priority: 'critical'
    })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.tier).toBe('in-progress')
    expect(f.focus?.id).toBe('TASK-1')
  })

  it('AC-3: an overdue TODO beats a READY task when no session, in-progress or pinned task exists', async () => {
    await svc.createTask({
      id: 'TASK-1',
      projectId: 'p',
      title: 'late',
      status: 'TODO',
      dueDate: '2026-10-20'
    })
    await svc.createTask({
      id: 'TASK-2',
      projectId: 'p',
      title: 'ready',
      status: 'READY',
      priority: 'critical'
    })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.tier).toBe('overdue')
    expect(f.focus?.id).toBe('TASK-1')
  })

  it('AC-4: among READY medium, critical and high, focus is critical and also lists high then medium', async () => {
    await svc.createTask({
      id: 'TASK-1',
      projectId: 'p',
      title: 'm',
      status: 'READY',
      priority: 'medium'
    })
    await svc.createTask({
      id: 'TASK-2',
      projectId: 'p',
      title: 'c',
      status: 'READY',
      priority: 'critical'
    })
    await svc.createTask({
      id: 'TASK-3',
      projectId: 'p',
      title: 'h',
      status: 'READY',
      priority: 'high'
    })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.tier).toBe('ready')
    expect(f.focus?.id).toBe('TASK-2')
    expect(f.also.map((a) => a.id)).toEqual(['TASK-3', 'TASK-1'])
  })

  it('AC-5: a READY task whose blocker is TODO is never the focus; alone, the project falls to the next tier or cold', async () => {
    await svc.createTask({ id: 'TASK-1', projectId: 'p', title: 'blocker', status: 'TODO' })
    await svc.createTask({
      id: 'TASK-2',
      projectId: 'p',
      title: 'blocked',
      status: 'READY',
      blockedBy: ['TASK-1']
    })

    const cold = await resolveFocus(svc, 'p', NOW)
    expect(cold.tier).toBe('cold')
    expect(cold.focus).toBeNull()

    await svc.updateTask('TASK-1', { dueDate: '2026-10-25' })
    const next = await resolveFocus(svc, 'p', NOW)
    expect(next.tier).toBe('due-soon')
    expect(next.focus?.id).toBe('TASK-1')
  })

  it('AC-6: an open task whose subtasks are DONE and IMPLEMENTED is not the ready focus and is listed in awaitingClose', async () => {
    await svc.createTask({
      id: 'TASK-1',
      projectId: 'p',
      title: 'epic',
      status: 'READY',
      priority: 'critical'
    })
    await svc.createTask({
      id: 'TASK-2',
      projectId: 'p',
      title: 's1',
      status: 'DONE',
      parentTaskId: 'TASK-1'
    })
    await svc.createTask({
      id: 'TASK-3',
      projectId: 'p',
      title: 's2',
      status: 'IMPLEMENTED',
      parentTaskId: 'TASK-1'
    })
    await svc.createTask({
      id: 'TASK-4',
      projectId: 'p',
      title: 'work',
      status: 'READY',
      priority: 'low'
    })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.tier).toBe('ready')
    expect(f.focus?.id).toBe('TASK-4')
    expect(f.awaitingClose).toEqual([{ id: 'TASK-1', title: 'epic' }])
  })

  it("AC-7: resume carries the resumePoint of the focus task's newest session with a handoff", async () => {
    await svc.createTask({ id: 'TASK-1', projectId: 'p', title: 'a', status: 'READY' })
    const s1 = await svc.startSession({ projectId: 'p', taskId: 'TASK-1' })
    await svc.endSession(s1.session.id, { handoff: { resumePoint: 'first stop' } })
    await svc.updateTask('TASK-1', { status: 'READY' })
    await new Promise((r) => setTimeout(r, 15))
    const s2 = await svc.startSession({ projectId: 'p', taskId: 'TASK-1' })
    await svc.endSession(s2.session.id, {
      handoff: { resumePoint: 'second stop', looseEnds: ['x'] }
    })
    await svc.updateTask('TASK-1', { status: 'READY' })

    const f = await resolveFocus(svc, 'p', NOW)
    expect(f.focus?.id).toBe('TASK-1')
    expect(f.resume).toEqual({
      sessionId: s2.session.id,
      resumePoint: 'second stop',
      looseEnds: ['x']
    })
  })
})

describe('focus_board tool', () => {
  async function call(args: unknown): Promise<unknown> {
    let cb: ((a: unknown) => Promise<unknown>) | null = null
    const server = {
      registerTool: (_n: string, _c: unknown, fn: (a: unknown) => Promise<unknown>) => {
        cb = fn
      },
      registeredToolNames: []
    } as unknown as InstrumentedServer
    register(server, svc)
    const out = (await cb!(args)) as { content: { text: string }[] }
    return JSON.parse(out.content[0].text)
  }

  it('AC-8: a project with no open task is cold with focus null, and no projectId returns one entry per project', async () => {
    await svc.ensureProject('q', 'Q', tmp)
    await svc.createTask({ id: 'TASK-1', projectId: 'q', title: 'only', status: 'READY' })

    const board = (await call({})) as { projectId: string; tier: string; focus: unknown }[]
    const projects = (await svc.listProjects()).map((p) => p.id).sort()
    expect(board.map((e) => e.projectId).sort()).toEqual(projects)
    const p = board.find((e) => e.projectId === 'p')!
    expect(p.tier).toBe('cold')
    expect(p.focus).toBeNull()
    expect(board.find((e) => e.projectId === 'q')!.tier).toBe('ready')
  })

  it('answers UNKNOWN_PROJECT in the body for a project that does not exist', async () => {
    expect(await call({ projectId: 'nope' })).toMatchObject({ error: 'UNKNOWN_PROJECT' })
  })
})
