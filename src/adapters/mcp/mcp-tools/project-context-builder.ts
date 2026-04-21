import * as fs from 'fs'
import * as path from 'path'
import type {
  Phase,
  Task,
  Session,
  Conversation,
  ContextSource,
  DerivedProgress
} from '../../../core/domain/task-types'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { ContextSourceOperations } from '../../../core/domain/interfaces/context-source-repository.interface'
import type { PhaseOperations } from '../../../core/domain/interfaces/phase-repository.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import type { SessionOperations } from '../../../core/domain/interfaces/session-repository.interface'
import type { ConversationOperations } from '../../../core/domain/interfaces/conversation-repository.interface'

export type ProjectContextDeps = ProjectOperations &
  ContextSourceOperations &
  PhaseOperations &
  TaskOperations &
  SessionOperations &
  ConversationOperations

export type ProjectContextDepth = 'summary' | 'full'

export interface ProjectContextBundle {
  project: { id: string; name: string; cwd: string }
  currentState: {
    activePhase: { id: string; title: string; progress: DerivedProgress } | null
    activeTasks: Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>>
    lastSession: { id: string; endedAt: string | null; handoff: Session['handoff'] } | null
    openConversations: Array<{
      id: string
      title: string
      status: Conversation['status']
      participants: string[]
      recentMessages: Array<{ author: string; content: string; type: string; at: string }>
    }>
  }
  architecture: string | null
  conventions: string | null
  recentDecisions: Array<{ label: string; sourcePath: string; excerpt: string }>
  contextSources: Array<Pick<ContextSource, 'label' | 'category' | 'sourcePath'>>
}

const SUMMARY_MAX_CHARS = 600

export function buildProjectContext(
  svc: ProjectContextDeps,
  projectId: string,
  depth: ProjectContextDepth = 'full',
  contentRoot = process.env.CHODA_CONTENT_ROOT || ''
): ProjectContextBundle | null {
  const project = fetchProject(svc, projectId)
  if (!project) return null

  const sources = svc.findContextSources(projectId, true)

  return {
    project,
    currentState: {
      activePhase: pickActivePhase(svc, projectId),
      activeTasks: pickActiveTasks(svc, projectId),
      lastSession: pickLastSession(svc, projectId),
      openConversations: pickOpenConversations(svc, projectId)
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

function fetchProject(
  svc: ProjectContextDeps,
  projectId: string
): ProjectContextBundle['project'] | null {
  return svc.getProject(projectId)
}

function pickActivePhase(
  svc: ProjectContextDeps,
  projectId: string
): ProjectContextBundle['currentState']['activePhase'] {
  const phases = svc.findPhases(projectId)
  const active =
    phases.find((p: Phase) => p.startDate && !p.completedDate) ??
    phases.find((p: Phase) => p.status === 'open') ??
    null
  if (!active) return null
  return { id: active.id, title: active.title, progress: svc.getPhaseProgress(active.id) }
}

function pickActiveTasks(
  svc: ProjectContextDeps,
  projectId: string
): Array<Pick<Task, 'id' | 'title' | 'status' | 'priority'>> {
  const inProgress = svc.findTasks({ projectId, status: 'IN-PROGRESS' })
  const ready = svc.findTasks({ projectId, status: 'READY' })
  return [...inProgress, ...ready]
    .slice(0, 20)
    .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority }))
}

function pickLastSession(
  svc: ProjectContextDeps,
  projectId: string
): ProjectContextBundle['currentState']['lastSession'] {
  const completed = svc.findSessions(projectId, 'completed')
  const latest = completed[0]
  if (!latest) return null
  return { id: latest.id, endedAt: latest.endedAt, handoff: latest.handoff }
}

function pickOpenConversations(
  svc: ProjectContextDeps,
  projectId: string
): ProjectContextBundle['currentState']['openConversations'] {
  const open = [
    ...svc.findConversations(projectId, 'open'),
    ...svc.findConversations(projectId, 'discussing')
  ]
  return open.map((c) => {
    const messages = svc.getConversationMessages(c.id)
    const recentMessages = messages.slice(-3).map((m) => ({
      author: m.authorName,
      content: m.content.slice(0, 200),
      type: m.messageType,
      at: m.createdAt
    }))
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      participants: svc.getConversationParticipants(c.id).map((p) => p.name),
      recentMessages
    }
  })
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
