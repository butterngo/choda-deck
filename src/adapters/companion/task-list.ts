// TASK-1773 — GET /tasks used to pass `{}` to findTasks and hand back the whole
// table: 4,042,663 bytes, 1420 tasks, every row carrying its full body, and both
// `?projectId=` and `?workspaceId=` silently ignored. Silent-ignore is the
// dangerous half — a caller cannot tell a working filter from a discarded one,
// so the companion could not know its list was unscoped.
//
// Two separate problems, fixed here as one route:
//
//   1. FILTERING. `findTasks` has always accepted { projectId, status, limit };
//      graph.ts and workflow.ts already use it. Only this route ignored it.
//   2. WORKSPACE SCOPE. Tasks carry no workspaceId, so scope is derived — the
//      cascade `/choda-task-focus` §5.3 defines: touches first, session second,
//      and anything matching neither is FLAGGED, never dropped.
//
// The third rule is the one worth defending. Dropping an unscoped task would
// make the list look clean while lying: a reader would conclude the workspace
// has nothing to do with that task, when the truth is that nobody recorded
// which workspace it belongs to. A visible marker says "unknown" out loud.

import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { Task, TaskFilter, TaskStatus } from '../../core/domain/task-types'
import { TASK_STATUSES } from '../../core/domain/task-types'

/**
 * Which arm of the cascade claimed this task.
 *
 * `touches`  — a code_ref belonging to this workspace has a TOUCHES edge to it.
 * `session`  — no touches, but a session in this workspace was bound to it.
 * `unscoped` — neither. The task is still returned, carrying this marker.
 */
export type TaskScope = 'touches' | 'session' | 'unscoped'

/**
 * A task as a LIST needs it. `body` is deliberately absent: it averaged 2.8 KB
 * a row and accounted for nearly all of the old 4 MB response, while a list
 * renders id, title and status. Whoever needs a body asks GET /tasks/:id.
 */
export interface TaskListRow {
  id: string
  projectId: string
  parentTaskId: string | null
  title: string
  status: TaskStatus
  priority: string | null
  labels: string[]
  dueDate: string | null
  pinned: boolean
  blockedBy: string[]
  createdAt: string
  updatedAt: string
  /** Present only when the request named a workspace. */
  scope?: TaskScope
}

export interface TaskListQuery {
  filter: TaskFilter
  workspaceId: string | null
}

/**
 * Reject rather than ignore. A rejected filter is a bug report; an ignored one
 * is 1420 rows that look like an answer — which is exactly how this route
 * shipped for months without anyone noticing it filtered nothing.
 *
 * Note what is NOT validated here: an unknown `projectId` is passed through, so
 * it comes back as an empty list. That is honest — the caller asked about a
 * project that holds no tasks — and it is never the full table.
 */
export function parseTaskListQuery(params: URLSearchParams): TaskListQuery | { error: string } {
  const filter: TaskFilter = {}

  const projectId = params.get('projectId')
  if (projectId !== null) {
    if (projectId.trim() === '') return { error: 'projectId must not be empty' }
    filter.projectId = projectId
  }

  const status = params.get('status')
  if (status !== null) {
    if (!(TASK_STATUSES as string[]).includes(status)) {
      return { error: `unknown status "${status}" — expected one of ${TASK_STATUSES.join(', ')}` }
    }
    filter.status = status as TaskStatus
  }

  const rawLimit = params.get('limit')
  if (rawLimit !== null) {
    const limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit <= 0) {
      return { error: `limit must be a positive integer, got "${rawLimit}"` }
    }
    filter.limit = limit
  }

  const workspaceId = params.get('workspaceId')
  if (workspaceId !== null && workspaceId.trim() === '') {
    return { error: 'workspaceId must not be empty' }
  }

  return { filter, workspaceId }
}

/** Strip `body`, keep everything a list view reads. */
export function toTaskListRow(task: Task): TaskListRow {
  return {
    id: task.id,
    projectId: task.projectId,
    parentTaskId: task.parentTaskId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
    pinned: task.pinned,
    blockedBy: task.blockedBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}

/**
 * Run the §5.3 cascade for one workspace and return the scope of every task id
 * it can classify. Ids absent from the map are `unscoped` — the caller applies
 * that default, so "no entry" and "explicitly unscoped" cannot drift apart.
 *
 * Cost note: this reads the project's code_refs and sessions once each, not once
 * per task. An N+1 here would be paid on every poll of the workspace view.
 */
export async function scopeTasksToWorkspace(
  svc: BackendTaskService,
  projectId: string,
  workspaceId: string
): Promise<Map<string, TaskScope>> {
  const scopes = new Map<string, TaskScope>()

  // Bucket 1 — touches. code_refs already carry `workspaceId`, so this is a
  // direct match and not the path-prefix comparison against the workspace cwd
  // that §5.3 describes. The column is the same fact, recorded rather than
  // re-derived, and a recorded fact cannot disagree with itself over a trailing
  // slash or a drive-letter case difference.
  const codeRefs = await svc.listCodeRefsByPrefix({ projectId })
  for (const ref of codeRefs) {
    if (ref.workspaceId !== workspaceId) continue
    for (const edge of await svc.getTouchesForCodeRef(ref.slug)) {
      scopes.set(edge.taskId, 'touches')
    }
  }

  // Bucket 2 — session-derived, and only where touches said nothing. Touches
  // wins because it is a claim about the CODE; a session is a claim about where
  // someone happened to be sitting, which is weaker evidence of ownership.
  for (const session of await svc.findSessions(projectId)) {
    if (session.workspaceId !== workspaceId) continue
    if (session.taskId === null) continue
    if (scopes.has(session.taskId)) continue
    scopes.set(session.taskId, 'session')
  }

  return scopes
}

/**
 * The route body. Without `workspaceId` this is a plain filtered list; with one
 * it additionally annotates every row.
 *
 * Scoping ANNOTATES, it does not drop. See the header comment — a silently
 * shortened list is the failure mode this whole task exists to remove.
 */
export async function listTasks(
  svc: BackendTaskService,
  query: TaskListQuery,
  workspaceProjectId: string | null
): Promise<TaskListRow[]> {
  const filter =
    query.workspaceId !== null && workspaceProjectId !== null
      ? { ...query.filter, projectId: workspaceProjectId }
      : query.filter

  const rows = (await svc.findTasks(filter)).map(toTaskListRow)
  if (query.workspaceId === null || workspaceProjectId === null) return rows

  const scopes = await scopeTasksToWorkspace(svc, workspaceProjectId, query.workspaceId)
  return rows.map((row) => ({ ...row, scope: scopes.get(row.id) ?? 'unscoped' }))
}
