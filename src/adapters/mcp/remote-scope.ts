// TASK-2244 — every remote tool answers only within the caller's projects.
//
// One wrapper around the service, applied once at boot for the HTTP transport:
// each scoped method reads the request's caller (TASK-2242) and, for a member,
// filters reads to their project_members rows (TASK-2243), turns a foreign id
// into the same "not found" an unknown id produces, and refuses writes that
// name a foreign or missing project. A converter, the static bearer and the
// stdio transport (no caller) pass straight through.
//
// REMOTE_TOOL_SCOPING names how each allowlisted tool is covered; boot refuses
// to start, and a test fails, when a tool is allowlisted without an entry, so
// widening the remote surface cannot forget the scoping.

import { currentCaller, type CallerIdentity } from './caller-identity'
import type { InboxFilter, TaskFilter } from '../../core/domain/task-types'

export interface MembershipSource {
  listProjectsFor(member: string): Promise<string[]>
}

// A backend with no membership table (SQLite over HTTP) grants members nothing.
export const NO_MEMBERSHIP: MembershipSource = { listProjectsFor: async () => [] }

export const REMOTE_TOOL_SCOPING: Readonly<Record<string, string>> = Object.freeze({
  project_list: 'listProjects keeps only the member’s projects',
  task_list: 'findTasks: a foreign projectId returns [], other rows filtered',
  task_context: 'getTask returns null for a foreign task → the unknown-id reply',
  inbox_list: 'findInbox filtered; items with no project are hidden from members',
  inbox_get: 'getInbox returns null for a foreign or project-less item',
  inbox_add: 'createInbox refuses a foreign or missing projectId',
  conversation_open: 'openConversation refuses a foreign projectId',
  conversation_add: 'getConversation returns null for a foreign thread → unknown-id error',
  conversation_read: 'getConversation returns null for a foreign thread',
  conversation_list: 'findConversations: a foreign projectId returns []'
})

export function unscopedTools(allowlist: Iterable<string>): string[] {
  return [...allowlist].filter((tool) => !(tool in REMOTE_TOOL_SCOPING))
}

export function assertAllowlistScoped(allowlist: Iterable<string>): void {
  const missing = unscopedTools(allowlist)
  if (missing.length > 0) {
    throw new Error(
      `remote tool(s) allowlisted without project scoping: ${missing.join(', ')} — ` +
        'add an entry to REMOTE_TOOL_SCOPING and a scoped service method (TASK-2244)'
    )
  }
}

export class ForeignProjectError extends Error {
  constructor(projectId: string | null | undefined) {
    super(
      projectId
        ? `Project ${projectId} is not available to this account`
        : 'A projectId is required for this account'
    )
    this.name = 'ForeignProjectError'
  }
}

type AnyFn = (...args: unknown[]) => Promise<unknown>
type Scoped = (allowed: ReadonlySet<string>, original: AnyFn, args: unknown[]) => Promise<unknown>

interface WithProject {
  projectId: string | null
}

const inProject = (allowed: ReadonlySet<string>, row: unknown): boolean => {
  const projectId = (row as WithProject | null)?.projectId
  return typeof projectId === 'string' && allowed.has(projectId)
}

const keepOwn: Scoped = async (allowed, original, args) =>
  ((await original(...args)) as unknown[]).filter((row) => inProject(allowed, row))

const nullIfForeign: Scoped = async (allowed, original, args) => {
  const row = await original(...args)
  return row && inProject(allowed, row) ? row : null
}

const requireOwnProject =
  (projectIdOf: (args: unknown[]) => string | null | undefined): Scoped =>
  async (allowed, original, args) => {
    const projectId = projectIdOf(args)
    if (!projectId || !allowed.has(projectId)) throw new ForeignProjectError(projectId)
    return original(...args)
  }

const SCOPED_METHODS: Readonly<Record<string, Scoped>> = {
  listProjects: async (allowed, original, args) =>
    ((await original(...args)) as Array<{ id: string }>).filter((p) => allowed.has(p.id)),
  findTasks: async (allowed, original, args) => {
    const filter = args[0] as TaskFilter | undefined
    if (filter?.projectId !== undefined && !allowed.has(filter.projectId)) return []
    return keepOwn(allowed, original, args)
  },
  getTask: nullIfForeign,
  findInbox: async (allowed, original, args) => {
    const filter = args[0] as InboxFilter | undefined
    const projectId = filter?.projectId
    if (projectId === null) return []
    if (projectId !== undefined && !allowed.has(projectId)) return []
    return keepOwn(allowed, original, args)
  },
  getInbox: nullIfForeign,
  createInbox: requireOwnProject((args) => (args[0] as { projectId?: string | null })?.projectId),
  openConversation: requireOwnProject((args) => (args[0] as { projectId?: string })?.projectId),
  getConversation: nullIfForeign,
  findConversations: async (allowed, original, args) =>
    allowed.has(args[0] as string) ? keepOwn(allowed, original, args) : []
}

export function scopeServiceToCaller<T extends object>(
  svc: T,
  membership: MembershipSource,
  caller: () => CallerIdentity | undefined = currentCaller
): T {
  return new Proxy(svc, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || typeof value !== 'function') return value
      const original = (value as AnyFn).bind(target)
      const scoped = SCOPED_METHODS[prop]
      if (!scoped) return original
      return async (...args: unknown[]) => {
        const who = caller()
        if (!who || who.isConverter) return original(...args)
        const allowed = new Set(await membership.listProjectsFor(who.member))
        return scoped(allowed, original, args)
      }
    }
  })
}
