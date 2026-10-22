import type { IncomingMessage, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { InboxItem, Session, Task } from '../../core/domain/task-types'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'
import type { ProjectOperations } from '../../core/domain/interfaces/project-repository.interface'
import type { SessionOperations } from '../../core/domain/interfaces/session-repository.interface'
import type { TaskOperations } from '../../core/domain/interfaces/task-repository.interface'
import type { RelationshipOperations } from '../../core/domain/interfaces/relationship-repository.interface'
import type { KnowledgeOperations } from '../../core/domain/interfaces/knowledge-operations.interface'
import type { SessionEventOperations } from '../../core/domain/interfaces/session-event-operations.interface'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'
import {
  parseReportFrontmatter,
  reportFileName,
  type ReportFrontmatter
} from '../../core/domain/services/run-report'
import {
  deployChecklistFileName,
  parseDeployChecklist,
  type DeployItem
} from '../../core/domain/services/deploy-scan'
import {
  acCoverage,
  acRows,
  readAcTicks,
  type AcCoverage,
  type AcRow
} from '../../core/domain/lifecycle/ac-coverage'

// TASK-2531 — one record per loop run, for the companion's Runs screen
// (TASK-2532). Butter, 2026-10-19: "làm sao để biết được xong task nào, đã test
// những gì, còn gì". Everything a /choda-autopilot or /choda-burn-backlog run
// produces is already stored, just in five places: the [loop:<ws>] notices, the
// goal's subtasks, their acceptance checkboxes, each item's session handoff and
// its commits. The decide screen shows only the notices, and a dismissed notice
// is gone, so this joins them per run and keeps archived notices in.
//
// A run's state reads sessions before notices. On 2026-10-19 TASK-2513's newest
// notice said 🔴 halted while TASK-2517 had been working for an hour: the notice
// is a report of a moment, an active session is the present.

export type RunState = 'running' | 'finished' | 'halted' | 'waiting-merge' | 'idle'
/** TASK-2535 — the lifecycle stepper on the Runs screen. */
export type RunStage = 'started' | 'working' | 'pr-opened' | 'merged' | 'done'
export type NoticeKind = 'started' | 'finished' | 'blocked' | 'decision' | 'ready' | 'other'

export interface RunNotice {
  id: string
  workspaceId: string | null
  kind: NoticeKind
  /** First line, `[loop:<ws>]` removed. */
  title: string
  content: string
  createdAt: string
  /** raw = still on the decide screen; archived = dismissed there. */
  status: string
}

export interface RunItem {
  id: string
  title: string
  status: string
  ac: { ticked: number; total: number; humanOpen: string[] }
  /** "<sha> <subject>" as the newest handoff stored it, or null. */
  commit: string | null
  /**
   * TASK-2560 — every commit of every session on the item, newest session
   * first, deduped by sha. 19 handoffs hold more than one commit and 14 tasks
   * ran more than one session, so `commit` alone hides work. Each carries its
   * session's workspace, because the stored string names no repo.
   */
  commits: RunCommit[]
  tests: { passed: string[]; skipped: string[] } | null
  /** startedAt of an active session on this item, or null. */
  activeSince: string | null
  /** TASK-2535 — blockers that are items of the same goal; outside blockers left out. */
  deps: string[]
  /**
   * TASK-2597 — each `## Acceptance` criterion with how it was proven: the
   * newest ac_check tick of its index across the item's sessions.
   */
  acs: AcRow[]
  /** The first mermaid fence under `## Sequence`, else `Sequence: n/a — <reason>`, else null. */
  sequence: RunSequence
  coverage: AcCoverage
}

export type RunSequence = { mermaid: string } | { na: string } | null

export interface RunCommit {
  sha: string
  subject: string
  workspaceId: string | null
  sessionId: string
}

export interface Run {
  goal: { id: string; title: string; status: string; projectId: string }
  project: { id: string; name: string }
  state: RunState
  stage: RunStage
  failedAt: RunStage | null
  /** Distinct GitHub pull request links named in the run's notices, first seen first. */
  prUrls: string[]
  items: RunItem[]
  notices: RunNotice[]
  lastActivityAt: string
  /**
   * TASK-2590 — the feature the goal realizes (Butter, 2026-10-21: "tôi cần
   * biết đây là cái feature gì"). Null when the goal has no REALIZES edge.
   */
  feature: RunFeature | null
  /**
   * TASK-2601 — the goal's test report (`choda-deck run report`, TASK-2600),
   * read from the goal home workspace's working tree. Null when there is no
   * file; `summary: null` when its frontmatter does not parse, so the web can
   * say "report unreadable" instead of hiding it.
   */
  report: RunReportRef | null
  /**
   * TASK-2607 — the goal's deploy checklist from the same home workspace. Null
   * when there is no file; `items: null` when its frontmatter does not parse.
   */
  deploy: RunDeployRef | null
}

export interface RunDeployRef {
  path: string
  workspaceId: string
  items: DeployItem[] | null
}

export interface RunReportRef {
  /** Relative to the workspace cwd, `/` separated — opens via GET /workspace-docs/<workspaceId>/<path>. */
  path: string
  workspaceId: string
  summary: ReportFrontmatter | null
}

export interface RunFeature {
  slug: string
  title: string
  /** Opening of "## Why this exists" (else of the body), ≤ 400 chars. */
  why: string | null
  /** The edge points at a slug with no knowledge entry. */
  missing: boolean
}

export interface RunsDeps {
  svc: Pick<InboxOperations, 'findInbox'> &
    Pick<TaskOperations, 'getTask' | 'getSubtasks'> &
    Pick<SessionOperations, 'findSessions'> &
    Pick<ProjectOperations, 'getProject'> &
    Pick<WorkspaceOperations, 'findWorkspaces'> &
    Pick<RelationshipOperations, 'getRelationshipsFrom'> &
    Pick<KnowledgeOperations, 'getKnowledge'> &
    Pick<SessionEventOperations, 'listSessionEvents'>
  bridgeToken: string
}

const WHY_MAX = 400

/** First paragraph of a markdown body: the first run of non-blank, non-heading lines. */
function firstParagraph(markdown: string): string | null {
  const lines: string[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) {
      if (lines.length > 0) break
      continue
    }
    lines.push(line)
  }
  const text = lines.join(' ').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

/** "## Why this exists" first, else the body's own first paragraph; cut at a word near 400. */
export function featureWhy(body: string): string | null {
  const section = body.split(/^##\s+Why this exists\s*$/im)[1]?.split(/^##\s/m)[0]
  const text = (section !== undefined ? firstParagraph(section) : null) ?? firstParagraph(body)
  if (text === null || text.length <= WHY_MAX) return text
  const cut = text.lastIndexOf(' ', WHY_MAX)
  return `${text.slice(0, cut > 0 ? cut : WHY_MAX)}…`
}

async function runFeature(svc: RunsDeps['svc'], goalId: string): Promise<RunFeature | null> {
  const slug = (await svc.getRelationshipsFrom(goalId, 'REALIZES'))[0]?.toId
  if (!slug) return null
  const entry = await svc.getKnowledge(slug)
  if (!entry) return { slug, title: slug, why: null, missing: true }
  return { slug, title: entry.frontmatter.title, why: featureWhy(entry.body), missing: false }
}

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

/** The goal home workspace: the one whose cwd is the project's own. */
async function homeWorkspace(svc: RunsDeps['svc'], goal: Task): Promise<{ id: string; cwd: string } | null> {
  const project = await svc.getProject(goal.projectId)
  if (!project?.cwd) return null
  return (await svc.findWorkspaces(goal.projectId)).find((w) => samePath(w.cwd, project.cwd)) ?? null
}

/** A docs/reports file of the goal in its home workspace, or null when there is none. */
async function reportsFile(
  svc: RunsDeps['svc'],
  goal: Task,
  name: string
): Promise<{ rel: string; workspaceId: string; text: string } | null> {
  const home = await homeWorkspace(svc, goal)
  if (!home) return null
  const rel = `docs/reports/${name}`
  try {
    return { rel, workspaceId: home.id, text: await fs.promises.readFile(path.join(home.cwd, rel), 'utf8') }
  } catch {
    return null
  }
}

async function runReport(svc: RunsDeps['svc'], goal: Task): Promise<RunReportRef | null> {
  const f = await reportsFile(svc, goal, reportFileName(goal.id))
  return f ? { path: f.rel, workspaceId: f.workspaceId, summary: parseReportFrontmatter(f.text) } : null
}

/** TASK-2607 — the deploy checklist written by `choda-deck deploy scan` (TASK-2604). */
async function runDeploy(svc: RunsDeps['svc'], goal: Task): Promise<RunDeployRef | null> {
  const f = await reportsFile(svc, goal, deployChecklistFileName(goal.id))
  return f ? { path: f.rel, workspaceId: f.workspaceId, items: parseDeployChecklist(f.text) } : null
}

const LOOP_TAG =/^\[loop:([A-Za-z0-9._-]+)\]\s*/
const RUN_GOAL = /\brun (TASK-\d+)\b/
const TASK_ID = /\bTASK-\d+\b/g
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

export function noticeKind(text: string): NoticeKind {
  const head = text.trimStart()
  if (head.startsWith('🔴')) return 'blocked'
  if (head.startsWith('🟡')) return 'decision'
  if (head.startsWith('🟢')) return 'ready'
  if (head.startsWith('⚪')) return /\bfinished\b/.test(head) ? 'finished' : 'started'
  return 'other'
}

export function toNotice(item: InboxItem): RunNotice | null {
  const m = LOOP_TAG.exec(item.content)
  if (!m) return null
  const rest = item.content.slice(m[0].length)
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    kind: noticeKind(rest),
    title: rest.split(/\r?\n/)[0]?.trim() ?? '',
    content: item.content,
    createdAt: item.createdAt,
    status: item.status
  }
}

/** The checkboxes under `## Acceptance` only — Test Plan checklists are not criteria. */
export function acceptanceCounts(body: string | null): RunItem['ac'] {
  const section = (body ?? '').split(/^## Acceptance[^\n]*$/m)[1]?.split(/^## /m)[0] ?? ''
  let ticked = 0
  let total = 0
  const humanOpen: string[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = /^\s*- \[( |x|X)\]\s*(.*)$/.exec(line)
    if (!m) continue
    total++
    if (m[1] !== ' ') ticked++
    else if (/\bhuman\b/i.test(m[2])) humanOpen.push(m[2].trim())
  }
  return { ticked, total, humanOpen }
}

export function runState(items: RunItem[], notices: RunNotice[]): RunState {
  if (items.some((i) => i.activeSince)) return 'running'
  const newest = [...notices].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  switch (newest?.kind) {
    case 'finished':
      return 'finished'
    case 'blocked':
      return 'halted'
    case 'ready':
      return 'waiting-merge'
    default:
      return 'idle'
  }
}

/**
 * The stepper position, read in a fixed order: a finished notice wins, then a
 * PR closed without merge, then an open PR, then a refusal at start, then any
 * finished or active item. TASK-2447's PR was closed after its 🟢 ready
 * notice, so "closed" has to be checked before "ready".
 */
export function runStage(
  items: RunItem[],
  notices: RunNotice[]
): { stage: RunStage; failedAt: RunStage | null } {
  if (notices.some((n) => n.kind === 'finished')) return { stage: 'done', failedAt: null }
  if (notices.some((n) => n.content.includes('closed without merge'))) {
    return { stage: 'merged', failedAt: 'merged' }
  }
  if (notices.some((n) => n.kind === 'ready')) return { stage: 'pr-opened', failedAt: null }
  if (notices.some((n) => n.title.includes('refused'))) return { stage: 'started', failedAt: 'started' }
  const moved = items.some((i) => i.activeSince || i.status === 'IMPLEMENTED' || i.status === 'DONE')
  return { stage: moved ? 'working' : 'started', failedAt: null }
}

export function prUrls(notices: RunNotice[]): string[] {
  const seen: string[] = []
  for (const n of notices) {
    for (const url of n.content.match(PR_URL) ?? []) if (!seen.includes(url)) seen.push(url)
  }
  return seen
}

const byNumericId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })

/** `sessions` newest first. The stored string is "<sha> <subject>", split as task-provenance.ts does. */
export function itemCommits(sessions: Session[]): RunCommit[] {
  const seen = new Set<string>()
  const out: RunCommit[] = []
  for (const s of sessions) {
    for (const raw of s.handoff?.commits ?? []) {
      const space = raw.indexOf(' ')
      const sha = space === -1 ? raw : raw.slice(0, space)
      if (sha === '' || seen.has(sha)) continue
      seen.add(sha)
      out.push({
        sha,
        subject: space === -1 ? '' : raw.slice(space + 1),
        workspaceId: s.workspaceId ?? null,
        sessionId: s.id
      })
    }
  }
  return out
}

const SEQUENCE_NA = /^\s*Sequence:\s*n\/a\s*—\s*(.+?)\s*$/im

/** TASK-2597 — the item's own sequence diagram, as /choda-plan writes it. */
export function taskSequence(body: string | null): RunSequence {
  const text = body ?? ''
  const section = text.split(/^## Sequence[^\n]*$/m)[1]?.split(/^## /m)[0]
  if (section !== undefined) {
    const fence = /^\s*```mermaid\s*\r?\n([\s\S]*?)\r?\n\s*```/m.exec(section)
    if (fence) return { mermaid: fence[1] }
  }
  const na = SEQUENCE_NA.exec(text)
  return na ? { na: na[1] } : null
}

async function toItem(
  svc: RunsDeps['svc'],
  task: Task,
  sessions: Session[],
  goalItems: Set<string>
): Promise<RunItem> {
  const mine = sessions
    .filter((s) => s.taskId === task.id)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const active = mine.find((s) => s.status === 'active') ?? null
  const withHandoff = mine.find((s) => s.handoff)
  const handoff = withHandoff?.handoff ?? null
  const ticks = await readAcTicks((id, type) => svc.listSessionEvents(id, type), task.id, mine.map((s) => s.id))
  const acs = acRows(task.body, ticks)
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    ac: acceptanceCounts(task.body),
    commit: handoff?.commits?.[0] ?? null,
    commits: itemCommits(mine),
    tests: handoff?.testResults
      ? { passed: handoff.testResults.passed ?? [], skipped: handoff.testResults.skipped ?? [] }
      : null,
    activeSince: active?.startedAt ?? null,
    deps: task.blockedBy.filter((id) => goalItems.has(id)).sort(byNumericId),
    acs,
    sequence: taskSequence(task.body),
    coverage: acCoverage(acs)
  }
}

export async function buildRuns(
  svc: RunsDeps['svc']
): Promise<{ runs: Run[]; otherNotices: RunNotice[] }> {
  const [raw, archived] = await Promise.all([
    svc.findInbox({ status: 'raw' }),
    svc.findInbox({ status: 'archived' })
  ])
  const notices = [...raw, ...archived]
    .map(toNotice)
    .filter((n): n is RunNotice => n !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const byGoal = new Map<string, RunNotice[]>()
  const unplaced: RunNotice[] = []
  for (const n of notices) {
    const goal = RUN_GOAL.exec(n.content)?.[1]
    if (goal) byGoal.set(goal, [...(byGoal.get(goal) ?? []), n])
    else unplaced.push(n)
  }

  const sessionsByProject = new Map<string, Session[]>()
  const projectNames = new Map<string, string>()
  const runs: Run[] = []
  for (const [goalId, goalNotices] of byGoal) {
    const goal = await svc.getTask(goalId)
    if (!goal) {
      unplaced.push(...goalNotices)
      continue
    }
    if (!sessionsByProject.has(goal.projectId)) {
      sessionsByProject.set(goal.projectId, await svc.findSessions(goal.projectId))
    }
    const sessions = sessionsByProject.get(goal.projectId) ?? []
    const subtasks = await svc.getSubtasks(goalId)
    const goalItems = new Set(subtasks.map((t) => t.id))
    const items: RunItem[] = []
    for (const t of subtasks.sort((a, b) => byNumericId(a.id, b.id))) {
      items.push(await toItem(svc, t, sessions, goalItems))
    }
    if (!projectNames.has(goal.projectId)) {
      projectNames.set(goal.projectId, (await svc.getProject(goal.projectId))?.name || goal.projectId)
    }
    runs.push({
      goal: { id: goal.id, title: goal.title, status: goal.status, projectId: goal.projectId },
      project: { id: goal.projectId, name: projectNames.get(goal.projectId) ?? goal.projectId },
      state: 'idle',
      stage: 'started',
      failedAt: null,
      prUrls: [],
      items,
      notices: goalNotices,
      lastActivityAt: '',
      feature: await runFeature(svc, goal.id),
      report: await runReport(svc, goal),
      deploy: await runDeploy(svc, goal)
    })
  }

  // An item-level notice ("🔴 TASK-2515 blocked: …") names an item, not the run.
  const otherNotices: RunNotice[] = []
  for (const n of unplaced) {
    const ids = new Set(n.content.match(TASK_ID) ?? [])
    const run = runs.find((r) => r.items.some((i) => ids.has(i.id)))
    if (run) run.notices.push(n)
    else otherNotices.push(n)
  }

  for (const run of runs) {
    run.notices.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    run.state = runState(run.items, run.notices)
    Object.assign(run, runStage(run.items, run.notices))
    run.prUrls = prUrls(run.notices)
    run.lastActivityAt = [
      ...run.notices.map((n) => n.createdAt),
      ...run.items.map((i) => i.activeSince ?? '')
    ].reduce((a, b) => (b > a ? b : a), '')
  }
  runs.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  otherNotices.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return { runs, otherNotices }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

/** Returns true when it handled the request. */
export async function handleRunsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RunsDeps
): Promise<boolean> {
  if ((req.url ?? '/').split('?')[0] !== '/runs') return false
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, deps.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  if (req.method !== 'GET') return (sendJson(res, 405, { error: 'GET only' }), true)
  try {
    sendJson(res, 200, await buildRuns(deps.svc))
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message })
  }
  return true
}
