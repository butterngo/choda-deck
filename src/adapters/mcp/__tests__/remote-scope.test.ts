import { describe, it, expect } from 'vitest'
import { REMOTE_TOOL_ALLOWLIST } from '../server-bootstrap'
import {
  assertAllowlistScoped,
  ForeignProjectError,
  REMOTE_TOOL_SCOPING,
  scopeServiceToCaller,
  unscopedTools
} from '../remote-scope'
import type { CallerIdentity } from '../caller-identity'

// TASK-2244 — the allowlist-coverage guard (AC-9) and the scoping wrapper's
// rules, against an in-memory fake service (no database).

describe('REMOTE_TOOL_SCOPING covers the remote allowlist (AC-9)', () => {
  it('every allowlisted tool has a scoping entry', () => {
    expect(unscopedTools(REMOTE_TOOL_ALLOWLIST)).toEqual([])
    expect(() => assertAllowlistScoped(REMOTE_TOOL_ALLOWLIST)).not.toThrow()
  })

  it('an allowlisted tool with no scoping entry is refused, by name', () => {
    const widened = new Set([...REMOTE_TOOL_ALLOWLIST, 'task_create'])
    expect(unscopedTools(widened)).toEqual(['task_create'])
    expect(() => assertAllowlistScoped(widened)).toThrow(/task_create/)
  })

  it('the scoping table names no tool outside the allowlist', () => {
    expect(Object.keys(REMOTE_TOOL_SCOPING).sort()).toEqual([...REMOTE_TOOL_ALLOWLIST].sort())
  })
})

const fake = {
  listProjects: async () => [{ id: 'P1' }, { id: 'P2' }],
  findTasks: async () => [
    { id: 'T1', projectId: 'P1' },
    { id: 'T2', projectId: 'P2' }
  ],
  getTask: async (id: string) => ({ id, projectId: id === 'T2' ? 'P2' : 'P1' }),
  findInbox: async () => [
    { id: 'I1', projectId: 'P1' },
    { id: 'I2', projectId: 'P2' },
    { id: 'I3', projectId: null }
  ],
  getInbox: async (id: string) => ({ id, projectId: id === 'I3' ? null : 'P1' }),
  createInbox: async (input: { projectId: string }) => ({ id: 'I9', ...input }),
  findConversations: async (projectId: string) => [{ id: 'C1', projectId }],
  unscopedMethod: async () => 'untouched'
}

function scoped(caller: CallerIdentity | undefined): typeof fake {
  return scopeServiceToCaller(fake, { listProjectsFor: async () => ['P1'] }, () => caller)
}

describe('scopeServiceToCaller', () => {
  const an = scoped({ member: 'an', isConverter: false })

  it('filters list reads to the member’s projects', async () => {
    expect(await an.listProjects()).toEqual([{ id: 'P1' }])
    expect((await an.findTasks()).map((t) => t.id)).toEqual(['T1'])
    expect((await an.findInbox()).map((i) => i.id)).toEqual(['I1'])
  })

  it('a foreign or project-less id reads as not found', async () => {
    expect(await an.getTask('T2')).toBeNull()
    expect(await an.getInbox('I3')).toBeNull()
    expect(await an.getTask('T1')).toEqual({ id: 'T1', projectId: 'P1' })
  })

  it('refuses a write naming a foreign or missing project', async () => {
    await expect(an.createInbox({ projectId: 'P2' })).rejects.toBeInstanceOf(ForeignProjectError)
    await expect(an.createInbox({ projectId: '' })).rejects.toBeInstanceOf(ForeignProjectError)
    expect(await an.createInbox({ projectId: 'P1' })).toMatchObject({ projectId: 'P1' })
  })

  it('a foreign projectId on a list call returns an empty list', async () => {
    expect(await an.findConversations('P2')).toEqual([])
  })

  it('leaves methods without a scoping rule untouched', async () => {
    expect(await an.unscopedMethod()).toBe('untouched')
  })

  it('a converter and a request with no caller pass straight through', async () => {
    for (const s of [scoped({ member: 'butter', isConverter: true }), scoped(undefined)]) {
      expect((await s.listProjects()).length).toBe(2)
      expect(await s.getTask('T2')).toEqual({ id: 'T2', projectId: 'P2' })
    }
  })
})
