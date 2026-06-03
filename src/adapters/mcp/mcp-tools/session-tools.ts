import type { InstrumentedServer } from '../instrumented-server'
import { z } from 'zod'
import { textResponse } from './types'
import { buildProjectContext, type ProjectContextDeps } from './project-context-builder'
import { loadMcpRules } from '../rules/mcp-rules-loader'
import { LifecycleError } from '../../../core/domain/lifecycle/errors'
import type { Session, SessionCheckpoint, SessionHandoff, Task, TaskStatus } from '../../../core/domain/task-types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { WorkspaceOperations } from '../../../core/domain/interfaces/workspace-repository.interface'
import type { SessionOperations } from '../../../core/domain/interfaces/session-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { InboxOperations } from '../../../core/domain/interfaces/inbox-repository.interface'
import type { SessionLifecycleOperations } from '../../../core/domain/interfaces/session-lifecycle.interface'
import { resolveWorkspaceId } from './workspace-resolver'
import type { GitOps } from '../../../core/domain/knowledge-git'
import { splitLines } from '../../../core/utils/lines'
import { GitOpsImpl } from '../../../core/domain/knowledge-git'
import {
  collectFilesByCommit,
  suggestKnowledge,
  type SuggestedKnowledge
} from '../../../core/domain/knowledge-suggestions'
import { TranscriptOpsImpl, type TranscriptOps } from '../../../core/domain/session-transcript'

// Workspaces support N parallel active sessions (TASK-526).
// Status set: 'active' | 'completed' — no auto-abandon on session_start.

export type SessionToolsDeps = ProjectOperations &
  WorkspaceOperations &
  SessionOperations &
  TaskOperations &
  InboxOperations &
  SessionLifecycleOperations &
  ProjectContextDeps

// ADR-028 — structured session-summary payload. FE base fields are required when
// `summary` is provided; BE extension fields are optional. Server validates server-side;
// invalid → MCP returns Zod schema error before any DB write (full rollback).
//
// ADR-029 step 4 (TASK-913) — `filesChanged` + `acCoverage` are AI-optional;
// the server's aggregator fills them from channels 1+2 of the current session.
// AI-provided values always win; the aggregator only fills gaps.
const sessionSummarySchema = z.object({
  summary: z.string(),
  tasksDone: z.array(z.string()),
  tasksCreated: z.array(z.string()),
  tasksCancelled: z.array(z.string()),
  commits: z.array(z.string()).describe('Format: "<hash> <task-id>"'),
  filesChanged: z
    .array(z.string())
    .describe(
      'Format: "<path> (<what changed>)". Optional — server appends auto-derived entries from channel 1 (kind=file_modified) events for paths you did not list.'
    )
    .optional(),
  acCoverage: z
    .record(z.string(), z.string())
    .describe(
      'Map taskId → "N/M verified (how). K deferred: reason.". Optional — server derives from channel 2 (kind=ac_check) events when omitted, or appends " + K auto-detected" to AI-provided values when both exist.'
    )
    .optional(),
  conversations: z.array(z.string()),
  openItems: z.array(z.string()),
  tasksShipped: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        commits: z.array(z.string()),
        files: z.array(z.string()),
        tests: z.number(),
        confidence: z.number()
      })
    )
    .optional(),
  tasksNotDone: z.array(z.object({ id: z.string(), reason: z.string() })).optional(),
  testCoverageSummary: z.string().optional(),
  outstandingRisks: z.array(z.string()).optional(),
  branchState: z.string().optional()
})

const handoffInputSchema = {
  sessionId: z.string(),
  commits: z
    .array(z.string())
    .optional()
    .describe(
      'Format: "<short-sha> <subject>". Optional (ADR-031) — when omitted, the server derives commits from the session time window (filtered by the bound task id). Any value you provide wins; derivation only fills the gap.'
    ),
  decisions: z.array(z.string()).optional(),
  resumePoint: z
    .string()
    .optional()
    .describe(
      'One sentence: where you stopped + what to pick up next. Optional (ADR-031) — when omitted, the server derives it from the last text-bearing assistant turn in the session transcript. Best-effort; any value you provide wins.'
    ),
  looseEnds: z.array(z.string()).optional(),
  notes: z.string().optional(),
  testResults: z
    .object({
      passed: z.array(z.string()),
      skipped: z.array(z.string())
    })
    .optional()
    .describe(
      'Evidence matching task ## Test Plan — passed[] for verified items, skipped[] for deferred items with reason'
    ),
  summary: sessionSummarySchema
    .optional()
    .describe(
      'ADR-028 typed session-summary. When provided, persisted as one observation event with payload.kind="session_summary", atomic with session close. Omit for backward compat.'
    )
}

async function tryLifecycle<T>(
  fn: () => T | Promise<T>
): Promise<ReturnType<typeof textResponse>> {
  try {
    return textResponse(await fn())
  } catch (e) {
    if (e instanceof LifecycleError) return textResponse(e.message)
    throw e
  }
}

export const register = (
  server: InstrumentedServer,
  svc: SessionToolsDeps,
  git: GitOps = new GitOpsImpl(),
  transcript: TranscriptOps = new TranscriptOpsImpl()
): void => {
  server.registerTool(
    'session_start',
    {
      description:
        'Start a new work session bound to a specific task. Sets the task to IN-PROGRESS and returns last handoff + active context. Call task_list or roadmap first to pick a taskId. Pass cwd to auto-detect workspaceId from registered workspaces. Multiple active sessions per workspace are allowed, but a task can only be linked to one active session at a time. ' +
        'Response also includes `recalledMemories`: prior episodic/procedural memories matching the session scopes (task → workspace → project), ranked by importance. Empty array when nothing matches. When non-empty, echo a 1-line summary to the user so resumed context shows continuity from prior sessions — do NOT silently consume them.',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        taskId: z
          .string()
          .describe('Task ID to work on — set to IN-PROGRESS when the session starts'),
        workspaceId: z.string().optional().describe('Workspace ID (e.g. workflow-engine)'),
        cwd: z
          .string()
          .optional()
          .describe(
            'Current working directory — used to auto-detect workspaceId when not passed explicitly'
          ),
        ccSessionId: z
          .string()
          .optional()
          .describe(
            'Claude Code session UUID (the transcript .jsonl filename under ~/.claude/projects/). Pass it so session_end can derive resumePoint from the transcript (ADR-031). Optional — omitted falls back to heuristic correlation.'
          )
      }
    },
    async ({ projectId, taskId, workspaceId, cwd, ccSessionId }) =>
      tryLifecycle(async () => {
        const project = await svc.getProject(projectId)
        if (!project) throw new Error(`Project ${projectId} not found`)

        const resolvedWorkspaceId =
          resolveWorkspaceId({
            explicitWorkspaceId: workspaceId,
            cwd,
            workspaces: await svc.findWorkspaces(projectId)
          }) ?? undefined

        const { session, contextSources, existingActiveSessions, recalledMemories } =
          await svc.startSession({
            projectId,
            taskId,
            workspaceId: resolvedWorkspaceId,
            ccSessionId
          })
        const lastSession = await loadLastSession(svc, projectId, resolvedWorkspaceId)
        const bundle = await buildProjectContext(svc, projectId, 'summary')
        const rules = loadMcpRules()

        return {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          contextSources,
          mode: 'planning',
          lastSession,
          existingActiveSessions: summarizeActiveSessions(existingActiveSessions),
          projectSummary: buildProjectSummary(bundle),
          activeTasks: bundle?.currentState.activeTasks ?? [],
          openConversations: bundle?.currentState.openConversations ?? [],
          recalledMemories,
          suggestion: buildSuggestion(lastSession, bundle?.currentState.activeTasks ?? []),
          rules: {
            onSessionStart: rules.sessionStart,
            onCheckpoint: rules.sessionCheckpoint,
            onResume: rules.sessionResume,
            onSessionEnd: rules.sessionEnd
          }
        }
      })
  )

  server.registerTool(
    'session_list',
    {
      description:
        'List sessions for a project, sorted by startedAt DESC. Handoff excluded by default (set includeHandoff=true to include).',
      inputSchema: {
        projectId: z.string().describe('Project ID'),
        status: z.enum(['active', 'completed']).optional(),
        workspaceId: z.string().optional().describe('Filter by workspace ID'),
        limit: z.number().int().positive().optional().describe('Max results (default 50)'),
        includeHandoff: z.boolean().optional().describe('Include handoff JSON (default false)')
      }
    },
    async ({ projectId, status, workspaceId, limit, includeHandoff }) => {
      const all = await svc.findSessions(projectId, status)
      const filtered = workspaceId ? all.filter((s) => s.workspaceId === workspaceId) : all
      const sliced = filtered.slice(0, limit ?? 50)
      const out = sliced.map((s) => {
        const base = {
          id: s.id,
          projectId: s.projectId,
          workspaceId: s.workspaceId,
          taskId: s.taskId,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          status: s.status
        }
        return includeHandoff ? { ...base, handoff: s.handoff } : base
      })
      return textResponse({ total: out.length, sessions: out })
    }
  )

  server.registerTool(
    'session_checkpoint',
    {
      description:
        'Snapshot current progress on an active session without ending it. Overwrite-in-place — each call replaces the previous checkpoint. Use when pausing work or before risky ops so a future session_resume can pick up state after crash/restart.',
      inputSchema: {
        sessionId: z.string(),
        resumePoint: z.string().optional().describe('One-line pointer to where you stopped'),
        notes: z.string().optional().describe('Free-form context — what matters for resume'),
        lastConversationId: z.string().optional().describe('Most recent conversation touched'),
        dirtyFiles: z
          .array(z.string())
          .optional()
          .describe('Files edited but not yet committed'),
        lastCommit: z.string().optional().describe('Last commit SHA written in this session')
      }
    },
    async ({ sessionId, resumePoint, notes, lastConversationId, dirtyFiles, lastCommit }) =>
      tryLifecycle(async () => {
        const checkpoint: SessionCheckpoint = {
          resumePoint,
          notes,
          lastConversationId,
          dirtyFiles,
          lastCommit
        }
        const result = await svc.checkpointSession(sessionId, { checkpoint })
        return {
          sessionId: result.session.id,
          status: result.session.status,
          checkpoint: result.session.checkpoint,
          checkpointAt: result.session.checkpointAt
        }
      })
  )

  server.registerTool(
    'session_resume',
    {
      description:
        'Resume a previously-active session after crash or restart. Returns session row, last checkpoint (if any), linked conversations, and active context sources. Works on completed sessions too (read-only replay).',
      inputSchema: {
        sessionId: z.string()
      }
    },
    async ({ sessionId }) =>
      tryLifecycle(async () => {
        const result = await svc.resumeSession(sessionId)
        const rules = loadMcpRules()
        return {
          session: result.session,
          checkpoint: result.checkpoint,
          conversations: result.conversations,
          contextSources: result.contextSources,
          rules: { onResume: rules.sessionResume }
        }
      })
  )

  server.registerTool(
    'session_end',
    {
      description:
        'End a work session. If session has a task, marks it DONE. Persists handoff. Include testResults matching the task ## Test Plan — passed[] for verified items, skipped[] for deferred items with reason. ' +
        '`looseEnds` is NOT a catch-all dump — classify each candidate first: action items → `task_create`, dirty-state observations → `notes`, only genuine ideas needing research → `looseEnds`. See the `## On session_end` rule for details. ' +
        'Response also returns `memoryCandidates` (session events flagged memory_candidate=1) and `selfEditPrompt`. ' +
        'When `selfEditPrompt` is non-empty, treat the session as not fully closed until you have called `memory_write` for 1-3 entries worth keeping across sessions (or none, if nothing applies). Skip without prompting if `memoryCandidates` is empty.',
      inputSchema: handoffInputSchema
    },
    async (input) =>
      tryLifecycle(async () => {
        const commits = await resolveCommits(svc, git, input.sessionId, input.commits)
        const resumePoint = await resolveResumePoint(svc, transcript, input.sessionId, input.resumePoint)
        const handoff: SessionHandoff = {
          commits,
          decisions: input.decisions,
          resumePoint,
          looseEnds: input.looseEnds,
          tasksUpdated: [],
          testResults: input.testResults
        }
        const result = await svc.endSession(input.sessionId, { handoff, summary: input.summary })
        if (result.taskUpdated) handoff.tasksUpdated = [result.taskUpdated.id]

        const looseEndInboxIds = await createLooseEndInboxes(svc, input.looseEnds, result.session)
        const suggestedKnowledge = await buildSuggestedKnowledge(svc, git, result.session.projectId, handoff)

        return {
          sessionId: result.session.id,
          status: result.session.status,
          endedAt: result.session.endedAt,
          taskUpdated: result.taskUpdated,
          closedConversationIds: result.closedConversationIds,
          looseEndInboxIds,
          suggestedKnowledge,
          notes: input.notes,
          memoryCandidates: result.memoryCandidates,
          selfEditPrompt: result.selfEditPrompt
        }
      })
  )
}

// TASK-985 (ADR-031 Tier 1) — auto-derive handoff.commits from the session window
// when the caller omits them. AI-supplied commits always win (ADR-029 merge rule);
// derivation only fills the gap. Runs here in the async handler because git is async
// I/O — the sync endSession transaction stays pure.
export async function resolveCommits(
  svc: SessionOperations & ProjectOperations,
  git: GitOps,
  sessionId: string,
  provided: string[] | undefined
): Promise<string[] | undefined> {
  if (provided && provided.length > 0) return provided
  const session = await svc.getSession(sessionId)
  if (!session) return provided
  const project = await svc.getProject(session.projectId)
  const cwd = project?.cwd
  if (!cwd) return provided
  const derived = git.commitsInWindow(cwd, session.startedAt, session.taskId ?? undefined)
  return derived.length > 0 ? derived : provided
}

// TASK-985 (ADR-031 Tier 2) — auto-derive handoff.resumePoint from the session
// transcript when the caller omits it. AI-supplied value always wins; derivation
// only fills the gap. Best-effort: a transcript miss leaves resumePoint undefined
// (today's behaviour), never a wrong value.
export async function resolveResumePoint(
  svc: SessionOperations & ProjectOperations,
  transcript: TranscriptOps,
  sessionId: string,
  provided: string | undefined
): Promise<string | undefined> {
  if (provided && provided.trim()) return provided
  const session = await svc.getSession(sessionId)
  if (!session) return provided
  const project = await svc.getProject(session.projectId)
  const cwd = project?.cwd
  if (!cwd) return provided
  const derived = transcript.readResumePoint({
    cwd,
    ccSessionId: session.ccSessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt
  })
  return derived ?? provided
}

export async function buildSuggestedKnowledge(
  svc: ProjectOperations,
  git: GitOps,
  projectId: string,
  handoff: SessionHandoff
): Promise<SuggestedKnowledge[]> {
  const project = await svc.getProject(projectId)
  const cwd = project?.cwd ?? ''
  const filesByCommit = collectFilesByCommit(cwd, handoff.commits ?? [], git)
  return suggestKnowledge(handoff, { filesByCommit })
}

export interface LastSessionSummary {
  id: string
  endedAt: string | null
  resumePoint: string | null
  decisions: string[]
  commits: string[]
  looseEnds: string[]
  tasksUpdated: string[]
  testResults: { passed: string[]; skipped: string[] } | null
}

export async function loadLastSession(
  svc: SessionOperations,
  projectId: string,
  workspaceId?: string
): Promise<LastSessionSummary | null> {
  const completed = await svc.findSessions(projectId, 'completed')
  const match = workspaceId ? completed.find((s) => s.workspaceId === workspaceId) : completed[0]
  if (!match) return null
  const h: SessionHandoff = match.handoff ?? {}
  return {
    id: match.id,
    endedAt: match.endedAt,
    resumePoint: h.resumePoint ?? null,
    decisions: h.decisions ?? [],
    commits: h.commits ?? [],
    looseEnds: h.looseEnds ?? [],
    tasksUpdated: h.tasksUpdated ?? [],
    testResults: h.testResults ?? null
  }
}

function buildProjectSummary(bundle: Awaited<ReturnType<typeof buildProjectContext>>): string | null {
  if (!bundle) return null
  const pieces: string[] = []
  if (bundle.architecture) {
    pieces.push(splitLines(bundle.architecture).slice(0, 3).join(' ').slice(0, 200))
  }
  return pieces.length > 0 ? pieces.join(' — ') : null
}

function summarizeActiveSessions(
  sessions: Session[]
): Array<{
  id: string
  workspaceId: string | null
  taskId: string | null
  startedAt: string
  hasCheckpoint: boolean
  checkpointAt: string | null
  hint: string
}> {
  return sessions.map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    taskId: s.taskId,
    startedAt: s.startedAt,
    hasCheckpoint: s.checkpoint !== null,
    checkpointAt: s.checkpointAt,
    hint: s.checkpoint
      ? 'Consider session_resume instead of starting new — this session has a checkpoint'
      : 'Session still active — resume or intentional parallel session?'
  }))
}

function buildSuggestion(
  lastSession: LastSessionSummary | null,
  activeTasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>
): string {
  if (lastSession?.resumePoint) {
    return `Resume: ${lastSession.resumePoint}`
  }
  const firstActive = activeTasks[0]
  if (firstActive) {
    return `Pick up ${firstActive.id} — ${firstActive.title}`
  }
  return 'No obvious resume point — review roadmap or pick a TODO'
}

export async function createLooseEndInboxes(
  svc: InboxOperations,
  looseEnds: string[] | undefined,
  session: Session
): Promise<string[]> {
  if (!looseEnds || looseEnds.length === 0) return []
  const tag = session.taskId ? `${session.id} (${session.taskId})` : session.id
  const ids: string[] = []
  for (const content of looseEnds) {
    const item = await svc.createInbox({
      projectId: session.projectId,
      content: `${content}\n\n— from session ${tag}`,
      ...(session.taskId ? { linkedTaskId: session.taskId } : {})
    })
    ids.push(item.id)
  }
  return ids
}

export async function applyTaskUpdates(
  svc: TaskOperations,
  updates?: Array<{ id: string; status: TaskStatus }>
): Promise<Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }>> {
  if (!updates || updates.length === 0) return []
  const out: Array<{ id: string; title: string; oldStatus: TaskStatus; newStatus: TaskStatus }> = []
  for (const u of updates) {
    const before = await svc.getTask(u.id)
    if (!before) continue
    const after = await svc.updateTask(u.id, { status: u.status })
    out.push({
      id: after.id,
      title: after.title,
      oldStatus: before.status,
      newStatus: after.status
    })
  }
  return out
}
