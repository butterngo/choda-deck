import * as fs from 'fs'
import * as path from 'path'
import type { SessionOperations } from '../../../core/domain/interfaces/session-repository.interface'
import type { ProjectOperations } from '../../../core/domain/interfaces/project-repository.interface'
import type { Session, SessionHandoff } from '../../../core/domain/task-types'

export function exportHandoffMarkdown(
  svc: SessionOperations & ProjectOperations,
  sessionId: string,
  contentRoot = process.env.CHODA_CONTENT_ROOT || ''
): string | null {
  if (!contentRoot) return null

  const session = svc.getSession(sessionId)
  if (!session) return null

  const project = svc.getProject(session.projectId)
  if (!project) return null

  const body = renderHandoff(session, project.name)
  const filePath = handoffPath(contentRoot, session.projectId)

  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, body, 'utf-8')
  return filePath
}

function handoffPath(contentRoot: string, projectId: string): string {
  return path.join(contentRoot, '10-Projects', projectId, 'handoff.md')
}

function renderHandoff(session: Session, projectName: string): string {
  const h: SessionHandoff = session.handoff ?? {}
  const date = (session.endedAt ?? session.startedAt).slice(0, 10)

  const lines: string[] = []
  lines.push('---')
  lines.push(`session: ${session.id}`)
  lines.push(`date: ${date}`)
  lines.push(`project: ${projectName}`)
  lines.push('---')
  lines.push('')
  lines.push('# Session Handoff')
  lines.push('')
  lines.push(section('What was done', bulletList(h.commits)))
  lines.push(section('Decisions made', bulletList(h.decisions)))
  lines.push(section('Resume point', h.resumePoint ? h.resumePoint : '_none_'))
  lines.push(section('Loose ends', bulletList(h.looseEnds)))
  lines.push(section('Tasks updated', renderTaskList(h.tasksUpdated)))
  lines.push(section('Test results', renderTestResults(h.testResults)))
  return lines.join('\n')
}

function renderTestResults(results?: { passed: string[]; skipped: string[] }): string {
  if (!results || (results.passed.length === 0 && results.skipped.length === 0)) return '_none_'
  const parts: string[] = []
  if (results.passed.length > 0) {
    parts.push('### Passed\n\n' + results.passed.map((i) => `- ${i}`).join('\n'))
  }
  if (results.skipped.length > 0) {
    parts.push('### Skipped\n\n' + results.skipped.map((i) => `- ${i}`).join('\n'))
  }
  return parts.join('\n\n')
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`
}

function bulletList(items?: string[]): string {
  if (!items || items.length === 0) return '_none_'
  return items.map((i) => `- ${i}`).join('\n')
}

function renderTaskList(ids?: string[]): string {
  if (!ids || ids.length === 0) return '_none_'
  return ids.map((id) => `- ${id}`).join('\n')
}
