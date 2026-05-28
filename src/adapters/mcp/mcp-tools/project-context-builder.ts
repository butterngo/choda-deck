import * as fs from 'fs'
import * as path from 'path'
import type {
  Task,
  Session,
  Conversation,
  ContextSource
} from '../../../core/domain/task-types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { ContextSourceOperations } from '../../../core/domain/interfaces/context-source-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { SessionOperations } from '../../../core/domain/interfaces/session-repository.interface'
import type { ConversationOperations } from '../../../core/domain/interfaces/conversation-repository.interface'
import type { InboxOperations } from '../../../core/domain/interfaces/inbox-repository.interface'
import { computeStaleRawWarning, type StaleRawWarning } from '../../../core/domain/inbox-triage-policy'

export type ProjectContextDeps = ProjectOperations &
  ContextSourceOperations &
  TaskOperations &
  SessionOperations &
  ConversationOperations &
  InboxOperations

export type ProjectContextDepth = 'summary' | 'full'

export interface ProjectContextBundle {
  project: { id: string; name: string; cwd: string }
  staleRawWarning: StaleRawWarning | null
  currentState: {
    activeTasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>
    lastSession: { id: string; endedAt: string | null; handoff: Session['handoff'] } | null
    openConversations: Array<{
      id: string
      title: string
      status: Conversation['status']
      participants: string[]
      recentMessages: Array<{ author: string; content: string; at: string }>
    }>
  }
  architecture: string | null
  conventions: string | null
  recentDecisions: Array<{ label: string; sourcePath: string; excerpt: string }>
  contextSources: Array<Pick<ContextSource, 'label' | 'category' | 'sourcePath'>>
}

const SUMMARY_MAX_CHARS = 600

export async function buildProjectContext(
  svc: ProjectContextDeps,
  projectId: string,
  depth: ProjectContextDepth = 'full',
  contentRoot = process.env.CHODA_CONTENT_ROOT || ''
): Promise<ProjectContextBundle | null> {
  const project = await fetchProject(svc, projectId)
  if (!project) return null

  const sources = await svc.findContextSources(projectId, true)
  const rawInbox = await svc.findInbox({ projectId, status: 'raw' })

  return {
    project,
    staleRawWarning: computeStaleRawWarning(rawInbox),
    currentState: {
      activeTasks: await pickActiveTasks(svc, projectId),
      lastSession: await pickLastSession(svc, projectId),
      openConversations: await pickOpenConversations(svc, projectId)
    },
    architecture: loadFileSource(sources, 'how', /architecture/i, contentRoot, depth),
    conventions: loadConventions(sources, contentRoot, depth),
    recentDecisions: loadRecentDecisions(sources, contentRoot, depth),
    contextSources: sources.map((s) => ({
      label: s.label,
      category: s.category,
      sourcePath: s.sourcePath
    }))
  }
}

async function fetchProject(
  svc: ProjectContextDeps,
  projectId: string
): Promise<ProjectContextBundle['project'] | null> {
  return svc.getProject(projectId)
}

async function pickActiveTasks(
  svc: ProjectContextDeps,
  projectId: string
): Promise<Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>> {
  const inProgress = await svc.findTasks({ projectId, status: 'IN-PROGRESS' })
  const ready = await svc.findTasks({ projectId, status: 'READY' })
  return [...inProgress, ...ready]
    .slice(0, 20)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }))
}

async function pickLastSession(
  svc: ProjectContextDeps,
  projectId: string
): Promise<ProjectContextBundle['currentState']['lastSession']> {
  const completed = await svc.findSessions(projectId, 'completed')
  const latest = completed[0]
  if (!latest) return null
  return { id: latest.id, endedAt: latest.endedAt, handoff: latest.handoff }
}

async function pickOpenConversations(
  svc: ProjectContextDeps,
  projectId: string
): Promise<ProjectContextBundle['currentState']['openConversations']> {
  const open = await svc.findConversations(projectId, 'open')
  return Promise.all(
    open.map(async (c) => {
      const messages = await svc.getConversationMessages(c.id)
      const recentMessages = messages.slice(-3).map((m) => ({
        author: m.authorName,
        content: m.content.slice(0, 200),
        at: m.createdAt
      }))
      const participants = await svc.getConversationParticipants(c.id)
      return {
        id: c.id,
        title: c.title,
        status: c.status,
        participants: participants.map((p) => p.name),
        recentMessages
      }
    })
  )
}

function loadFileSource(
  sources: ContextSource[],
  category: ContextSource['category'],
  matcher: RegExp,
  contentRoot: string,
  depth: ProjectContextDepth
): string | null {
  const match = sources.find(
    (s) => s.sourceType === 'file' && s.category === category && matcher.test(s.label)
  )
  if (!match) return null
  return readMarkdown(contentRoot, match.sourcePath, depth)
}

function loadConventions(
  sources: ContextSource[],
  contentRoot: string,
  depth: ProjectContextDepth
): string | null {
  const convs = sources.filter(
    (s) => s.sourceType === 'file' && s.category === 'how' && !/architecture/i.test(s.label)
  )
  if (convs.length === 0) return null
  const chunks = convs
    .map((s) => ({ label: s.label, content: readMarkdown(contentRoot, s.sourcePath, depth) }))
    .filter((c) => c.content)
    .map((c) => `## ${c.label}\n\n${c.content}`)
  return chunks.length > 0 ? chunks.join('\n\n') : null
}

function loadRecentDecisions(
  sources: ContextSource[],
  contentRoot: string,
  depth: ProjectContextDepth
): ProjectContextBundle['recentDecisions'] {
  return sources
    .filter((s) => s.sourceType === 'file' && s.category === 'decisions')
    .map((s) => {
      const content = readMarkdown(contentRoot, s.sourcePath, depth) ?? ''
      return { label: s.label, sourcePath: s.sourcePath, excerpt: content }
    })
    .filter((d) => d.excerpt.length > 0)
}

function readMarkdown(
  contentRoot: string,
  sourcePath: string,
  depth: ProjectContextDepth
): string | null {
  const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(contentRoot, sourcePath)
  if (!fs.existsSync(absolute)) return null
  try {
    const raw = fs.readFileSync(absolute, 'utf-8')
    const stripped = stripFrontmatter(raw)
    return depth === 'summary' ? summarize(stripped) : stripped
  } catch {
    return null
  }
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  return raw.slice(end + 4).replace(/^\n+/, '')
}

function summarize(content: string): string {
  const firstParagraphEnd = content.search(/\n\s*\n/)
  const head = firstParagraphEnd === -1 ? content : content.slice(0, firstParagraphEnd)
  return head.length > SUMMARY_MAX_CHARS ? head.slice(0, SUMMARY_MAX_CHARS).trimEnd() + '…' : head
}
