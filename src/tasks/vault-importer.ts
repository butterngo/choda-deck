/**
 * Vault Importer — parse vault .md files into SQLite
 * Derives all paths from contentRoot + projectId (PARA convention).
 */

import * as fs from 'fs'
import * as path from 'path'
import matter from 'gray-matter'
import * as chokidar from 'chokidar'
import type { SqliteTaskService } from './sqlite-task-service'
import type {
  TaskStatus,
  TaskPriority,
  DocumentType,
  RelationType,
  ContextCategory,
  ConversationMessageType
} from './task-types'

const DEFAULT_STATUS_MAP: Record<string, TaskStatus> = {
  todo: 'TODO',
  open: 'TODO',
  ready: 'READY',
  'in-progress': 'IN-PROGRESS',
  'in progress': 'IN-PROGRESS',
  doing: 'IN-PROGRESS',
  done: 'DONE',
  closed: 'DONE'
}

function normalizeStatus(
  raw: string | undefined,
  statusMap: Record<string, TaskStatus>
): TaskStatus {
  if (!raw) return 'TODO'
  return statusMap[raw.toLowerCase()] || 'TODO'
}

function normalizePriority(raw: string | undefined): TaskPriority | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (['critical', 'high', 'medium', 'low'].includes(lower)) return lower as TaskPriority
  return null
}

function extractId(filename: string, prefixes: string[]): string | null {
  const pattern = new RegExp(`^((?:${prefixes.join('|')})-\\d+[a-z]?)`)
  const match = filename.match(pattern)
  return match ? match[1] : null
}

function normalizeList(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}

// ── Path derivation (PARA convention) ─────────────────────────────────────

function projectDir(contentRoot: string, projectId: string): string {
  return path.join(contentRoot, '10-Projects', projectId)
}

function tasksDir(contentRoot: string, projectId: string): string {
  return path.join(projectDir(contentRoot, projectId), 'tasks')
}

function phasesDir(contentRoot: string, projectId: string): string {
  return path.join(projectDir(contentRoot, projectId), 'phases')
}

function docsDir(contentRoot: string, projectId: string): string {
  return path.join(projectDir(contentRoot, projectId), 'docs')
}

function archiveDir(contentRoot: string, projectId: string): string {
  return path.join(contentRoot, '90-Archive', projectId)
}

function fileExists(contentRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(contentRoot, relPath))
}

function recentDecisionFiles(contentRoot: string, relDir: string, limit: number): string[] {
  const abs = path.join(contentRoot, relDir)
  if (!fs.existsSync(abs)) return []
  const entries = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(abs, f)
      return { rel: `${relDir}/${f}`, mtime: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
  return entries.map((e) => e.rel)
}

function decisionLabel(relPath: string): string {
  const base = path.basename(relPath, '.md')
  return base.replace(/[_-]+/g, ' ')
}

// ── Import result ─────────────────────────────────────────────────────────

interface ImportResult {
  tasks: number
  phases: number
  documents: number
  conversations: number
  sessions: number
  tags: number
  relationships: number
  skipped: number
  errors: string[]
}

function emptyResult(): ImportResult {
  return {
    tasks: 0,
    phases: 0,
    documents: 0,
    conversations: 0,
    sessions: 0,
    tags: 0,
    relationships: 0,
    skipped: 0,
    errors: []
  }
}

// ── Importer ──────────────────────────────────────────────────────────────

export class VaultImporter {
  private taskService: SqliteTaskService
  private contentRoot: string
  private statusMap: Record<string, TaskStatus>
  private watcher: chokidar.FSWatcher | null = null

  constructor(
    taskService: SqliteTaskService,
    contentRoot: string,
    statusMap?: Record<string, string>
  ) {
    this.taskService = taskService
    this.contentRoot = contentRoot
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...(statusMap || {}) } as Record<string, TaskStatus>
  }

  /**
   * Full import: scan all project folders, import tasks, phases, documents
   */
  importAll(projectIds: string[]): ImportResult {
    const result = emptyResult()

    for (const projectId of projectIds) {
      this.taskService.ensureProject(projectId, projectId, projectDir(this.contentRoot, projectId))
      this.ensureDefaultContextSources(projectId)

      this.importTasks(projectId, result)
      this.importArchive(projectId, result)
      this.reconcileTaskFilePaths(projectId)
      this.importPhases(projectId, result)
      this.importDocuments(projectId, result)
      this.importConversations(projectId, result)
      this.importHandoff(projectId, result)
    }

    return result
  }

  // ── Default context sources ────────────────────────────────────────────

  private ensureDefaultContextSources(projectId: string): void {
    const existing = new Set(
      this.taskService.findContextSources(projectId).map((s) => s.sourcePath)
    )
    const candidates = this.defaultContextSourceCandidates(projectId)

    for (const c of candidates) {
      if (existing.has(c.sourcePath)) continue
      this.taskService.createContextSource({
        projectId,
        sourceType: 'file',
        sourcePath: c.sourcePath,
        label: c.label,
        category: c.category,
        priority: c.priority
      })
    }
  }

  private defaultContextSourceCandidates(projectId: string): Array<{
    label: string
    sourcePath: string
    category: ContextCategory
    priority: number
  }> {
    const out: Array<{
      label: string
      sourcePath: string
      category: ContextCategory
      priority: number
    }> = []
    const base = `10-Projects/${projectId}`

    // System overview
    if (fileExists(this.contentRoot, `${base}/context.md`)) {
      out.push({
        label: 'System Overview',
        sourcePath: `${base}/context.md`,
        category: 'what',
        priority: 10
      })
    }

    // Handoff (state)
    if (fileExists(this.contentRoot, `${base}/handoff.md`)) {
      out.push({
        label: 'Current Handoff',
        sourcePath: `${base}/handoff.md`,
        category: 'state',
        priority: 5
      })
    }

    // Architecture — check sub-project paths too
    const archCandidates = [
      `${base}/docs/architecture.md`,
      `${base}/workflow-engine/docs/architecture.md`
    ]
    const arch = archCandidates.find((p) => fileExists(this.contentRoot, p))
    if (arch) out.push({ label: 'Architecture', sourcePath: arch, category: 'how', priority: 20 })

    // Sub-project context files
    for (const sub of this.discoverSubDirs(base)) {
      const ctxPath = `${base}/${sub}/context.md`
      if (fileExists(this.contentRoot, ctxPath)) {
        out.push({ label: `${sub} Context`, sourcePath: ctxPath, category: 'how', priority: 25 })
      }
    }

    // FE standards
    const feStandards = `${base}/remote-workflow/docs/standards/fe-standards.md`
    if (fileExists(this.contentRoot, feStandards)) {
      out.push({ label: 'FE Standards', sourcePath: feStandards, category: 'how', priority: 30 })
    }

    // Decisions — scan multiple decision dirs
    const decisionDirs = [
      `${base}/docs/decisions`,
      `${base}/workflow-engine/docs/decisions`,
      `${base}/remote-workflow/docs/decisions`
    ]
    for (const dir of decisionDirs) {
      for (const rel of recentDecisionFiles(this.contentRoot, dir, 3)) {
        out.push({
          label: decisionLabel(rel),
          sourcePath: rel,
          category: 'decisions',
          priority: 35
        })
      }
    }

    // Features
    const featDir = path.join(this.contentRoot, base, 'features')
    if (fs.existsSync(featDir)) {
      const feats = fs
        .readdirSync(featDir)
        .filter((f) => f.endsWith('.md'))
        .slice(0, 5)
      for (const f of feats) {
        const rel = `${base}/features/${f}`
        out.push({
          label: `Feature: ${f.replace('.md', '').replace(/[-_]/g, ' ')}`,
          sourcePath: rel,
          category: 'what',
          priority: 40
        })
      }
    }

    return out
  }

  private discoverSubDirs(base: string): string[] {
    const abs = path.join(this.contentRoot, base)
    if (!fs.existsSync(abs)) return []
    return fs
      .readdirSync(abs, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith('.') &&
          d.name !== 'tasks' &&
          d.name !== 'phases' &&
          d.name !== 'docs' &&
          d.name !== 'features'
      )
      .map((d) => d.name)
  }

  // ── Task import ─────────────────────────────────────────────────────────

  private importTasks(projectId: string, result: ImportResult): void {
    const dir = tasksDir(this.contentRoot, projectId)
    if (!fs.existsSync(dir)) return

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      try {
        if (this.importTaskFile(path.join(dir, file), projectId, result)) result.tasks++
        else result.skipped++
      } catch (err) {
        result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private importArchive(projectId: string, result: ImportResult): void {
    const dir = archiveDir(this.contentRoot, projectId)
    if (!fs.existsSync(dir)) return

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      const taskId = extractId(file, ['TASK', 'BUG'])
      if (!taskId) continue
      try {
        if (this.importTaskFile(path.join(dir, file), projectId, result, true)) result.tasks++
        else result.skipped++
      } catch (err) {
        result.errors.push(`archive/${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private importTaskFile(
    filePath: string,
    projectId: string,
    result: ImportResult,
    archived = false
  ): boolean {
    const filename = path.basename(filePath)
    const taskId = extractId(filename, ['TASK', 'BUG'])
    if (!taskId) return false

    const content = fs.readFileSync(filePath, 'utf-8')
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      return false
    }

    const fm = parsed.data
    if (!fm || Object.keys(fm).length === 0) return false

    const status = archived ? 'DONE' : normalizeStatus(fm.status, this.statusMap)
    const priority = normalizePriority(fm.priority)
    const title = fm.title || taskId

    // Resolve phase from frontmatter (e.g. phase: sprint-1)
    const phaseRef = fm.phase ? String(fm.phase) : null
    const phaseId = phaseRef
      ? this.taskService.getPhase(phaseRef)
        ? phaseRef
        : undefined
      : undefined

    const existing = this.taskService.getTask(taskId)
    if (existing) {
      this.taskService.updateTask(taskId, {
        title,
        status,
        priority,
        labels: fm.labels || undefined,
        filePath,
        ...(phaseId !== undefined ? { phaseId } : {})
      })
    } else {
      this.taskService.createTask({
        id: taskId,
        projectId,
        title,
        status,
        priority: priority || undefined,
        labels: fm.labels,
        filePath,
        phaseId
      })
    }

    // Tags
    const tags = normalizeList(fm.tags)
    for (const tag of tags) {
      this.taskService.addTag(taskId, tag)
      result.tags++
    }

    // Relationships
    this.importRelationships(taskId, fm, result)

    return true
  }

  private reconcileTaskFilePaths(projectId: string): void {
    const tasks = this.taskService.findTasks({ projectId })
    for (const task of tasks) {
      if (task.filePath && !fs.existsSync(task.filePath)) {
        this.taskService.updateTask(task.id, { filePath: null })
      }
    }
  }

  // ── Phase import ────────────────────────────────────────────────────────

  private importPhases(projectId: string, result: ImportResult): void {
    const dir = phasesDir(this.contentRoot, projectId)
    if (!fs.existsSync(dir)) return

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      try {
        if (this.importPhaseFile(path.join(dir, file), projectId, result)) result.phases++
        else result.skipped++
      } catch (err) {
        result.errors.push(`phase/${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private importPhaseFile(filePath: string, projectId: string, result: ImportResult): boolean {
    const content = fs.readFileSync(filePath, 'utf-8')
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      return false
    }

    const fm = parsed.data
    if (!fm || !fm.id) return false

    const id = fm.id as string
    const title = fm.title || id
    const status = fm.status === 'closed' ? 'closed' : 'open'
    const position = typeof fm.position === 'number' ? fm.position : 0
    const startDate = fm.startDate || fm['start-date'] || null

    const existing = this.taskService.getPhase(id)
    if (existing) {
      this.taskService.updatePhase(id, { title, status, position, startDate })
    } else {
      this.taskService.createPhase({
        id,
        projectId,
        title,
        status,
        position,
        startDate: startDate || undefined
      })
    }

    // Tags
    const tags = normalizeList(fm.tags)
    for (const tag of tags) {
      this.taskService.addTag(id, tag)
      result.tags++
    }

    return true
  }

  // ── Document import ─────────────────────────────────────────────────────

  private importDocuments(projectId: string, result: ImportResult): void {
    const dir = docsDir(this.contentRoot, projectId)
    if (!fs.existsSync(dir)) return

    // Scan docs/decisions/ for ADRs
    const decisionsDir = path.join(dir, 'decisions')
    if (fs.existsSync(decisionsDir)) {
      this.importDocDir(decisionsDir, projectId, 'adr', result)
    }

    // Scan docs/ root for other doc types
    const rootFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of rootFiles) {
      try {
        if (this.importDocFile(path.join(dir, file), projectId, 'spec', result)) result.documents++
        else result.skipped++
      } catch (err) {
        result.errors.push(`docs/${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private importDocDir(
    dir: string,
    projectId: string,
    type: DocumentType,
    result: ImportResult
  ): void {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      try {
        if (this.importDocFile(path.join(dir, file), projectId, type, result)) result.documents++
        else result.skipped++
      } catch (err) {
        result.errors.push(`docs/${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  private importDocFile(
    filePath: string,
    projectId: string,
    defaultType: DocumentType,
    result: ImportResult
  ): boolean {
    const content = fs.readFileSync(filePath, 'utf-8')
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      return false
    }

    const fm = parsed.data
    const filename = path.basename(filePath, '.md')
    const id = (fm.id as string) || filename
    const title = (fm.title as string) || filename
    const type = (fm.type as DocumentType) || defaultType

    const existing = this.taskService.getDocument(id)
    if (existing) {
      this.taskService.updateDocument(id, { title, type, filePath })
    } else {
      this.taskService.createDocument({ id, projectId, type, title, filePath })
    }

    // Tags
    const tags = normalizeList(fm.tags)
    for (const tag of tags) {
      this.taskService.addTag(id, tag)
      result.tags++
    }

    return true
  }

  // ── Conversation import ─────────────────────────────────────────────────

  private importConversations(projectId: string, result: ImportResult): void {
    const filePath = path.join(projectDir(this.contentRoot, projectId), 'conversation.md')
    if (!fs.existsSync(filePath)) return

    const content = fs.readFileSync(filePath, 'utf-8')
    const threads = parseConversationThreads(content)

    for (const thread of threads) {
      try {
        const existing = this.taskService
          .findConversations(projectId)
          .find((c) => c.title === thread.title)
        if (existing) continue

        const status = thread.closed ? 'decided' : 'open'
        const conv = this.taskService.createConversation({
          projectId,
          title: thread.title,
          createdBy: thread.author,
          status,
          participants: thread.participants.map((p) => ({ name: p, type: 'role' as const }))
        })

        if (thread.closed) {
          this.taskService.updateConversation(conv.id, {
            status: 'decided',
            closedAt: thread.date
          })
        }

        for (const msg of thread.messages) {
          this.taskService.addConversationMessage({
            conversationId: conv.id,
            authorName: msg.author,
            content: msg.content,
            messageType: msg.type
          })
        }

        result.conversations++
      } catch (err) {
        result.errors.push(
          `conversation #${thread.number}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // ── Handoff import ─────────────────────────────────────────────────────

  private importHandoff(projectId: string, result: ImportResult): void {
    const filePath = path.join(projectDir(this.contentRoot, projectId), 'handoff.md')
    if (!fs.existsSync(filePath)) return

    const existing = this.taskService.findSessions(projectId, 'completed')
    if (existing.length > 0) return

    const content = fs.readFileSync(filePath, 'utf-8')
    const handoff = parseHandoffFile(content)
    if (!handoff) return

    try {
      const session = this.taskService.createSession({
        projectId,
        startedAt: handoff.date,
        status: 'completed',
        handoff: {
          commits: handoff.commits,
          decisions: handoff.decisions,
          resumePoint: handoff.resumePoint,
          looseEnds: handoff.looseEnds
        }
      })
      this.taskService.updateSession(session.id, { endedAt: handoff.date })
      result.sessions++
    } catch (err) {
      result.errors.push(`handoff: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Relationships from frontmatter ──────────────────────────────────────

  private importRelationships(
    itemId: string,
    fm: Record<string, unknown>,
    result: ImportResult
  ): void {
    const mapping: Array<{ key: string; type: RelationType }> = [
      { key: 'depends-on', type: 'DEPENDS_ON' },
      { key: 'implements', type: 'IMPLEMENTS' },
      { key: 'uses-tech', type: 'USES_TECH' },
      { key: 'decided-by', type: 'DECIDED_BY' }
    ]

    for (const { key, type } of mapping) {
      const targets = normalizeList(fm[key])
      for (const target of targets) {
        this.taskService.addRelationship(itemId, target, type)
        result.relationships++
      }
    }
  }

  // ── File watcher ────────────────────────────────────────────────────────

  startWatching(projectIds: string[]): void {
    const watchPaths = projectIds
      .flatMap((id) => [
        tasksDir(this.contentRoot, id),
        phasesDir(this.contentRoot, id),
        docsDir(this.contentRoot, id),
        archiveDir(this.contentRoot, id)
      ])
      .filter((p) => fs.existsSync(p))

    if (watchPaths.length === 0) return

    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })

    this.watcher.on('change', (filePath) => this.handleFileChange(filePath))
    this.watcher.on('add', (filePath) => this.handleFileChange(filePath))
  }

  private handleFileChange(filePath: string): void {
    if (!filePath.endsWith('.md')) return

    const relative = path.relative(this.contentRoot, filePath)
    const parts = relative.split(path.sep)

    let projectId: string | null = null
    let archived = false

    if (parts[0] === '10-Projects' && parts.length >= 4) {
      projectId = parts[1]
    } else if (parts[0] === '90-Archive' && parts.length >= 3) {
      projectId = parts[1]
      archived = true
    }

    if (!projectId) return

    const result = emptyResult()
    try {
      // Determine what kind of file changed
      const subdir = parts[2] // tasks, phases, docs
      if (subdir === 'tasks' || archived) {
        this.importTaskFile(filePath, projectId, result, archived)
      } else if (subdir === 'phases') {
        this.importPhaseFile(filePath, projectId, result)
      } else if (subdir === 'docs') {
        const type: DocumentType = parts[3] === 'decisions' ? 'adr' : 'spec'
        this.importDocFile(filePath, projectId, type, result)
      }
    } catch {
      // Ignore import errors from watcher
    }
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}

// ── Conversation parser ──────────────────────────────────────────────────

interface ParsedThread {
  number: number
  title: string
  closed: boolean
  date: string
  author: string
  participants: string[]
  messages: Array<{ author: string; content: string; type: ConversationMessageType }>
}

const THREAD_HEADER_RE = /^## #(\d+)\s+(.+?)(?:\s+—\s+(CLOSED|OPEN))?\s*$/

export function parseConversationThreads(content: string): ParsedThread[] {
  const lines = content.split('\n')
  const threads: ParsedThread[] = []
  let current: ParsedThread | null = null
  let msgLines: string[] = []
  let currentAuthor = ''
  let currentType: ConversationMessageType = 'question'

  function flushMessage(): void {
    if (!current || msgLines.length === 0) return
    const text = msgLines.join('\n').trim()
    if (text) {
      current.messages.push({ author: currentAuthor, content: text, type: currentType })
    }
    msgLines = []
  }

  for (const line of lines) {
    const headerMatch = line.match(THREAD_HEADER_RE)
    if (headerMatch) {
      flushMessage()
      current = {
        number: parseInt(headerMatch[1]),
        title: headerMatch[2].trim(),
        closed: headerMatch[3] === 'CLOSED',
        date: '',
        author: '',
        participants: [],
        messages: []
      }
      threads.push(current)
      currentAuthor = ''
      currentType = 'question'
      continue
    }

    if (!current) continue

    // Parse metadata lines
    const dateMatch = line.match(/^\*\*Date:\*\*\s*(.+)/)
    if (dateMatch) {
      current.date = dateMatch[1].trim()
      continue
    }

    const toMatch = line.match(/^\*\*To:\*\*\s*(.+)/)
    if (toMatch) {
      current.participants = toMatch[1].split(',').map((s) => s.trim())
      continue
    }

    // Reply headers: **BE reply — 2026-04-15:** or **FE reply — 2026-04-15 — CLOSED:**
    const replyMatch = line.match(
      /^\*\*(\w[\w\s]*?)\s+reply\s*—\s*[\d-]+(?:\s*—\s*CLOSED)?:\*\*\s*$/
    )
    if (replyMatch) {
      flushMessage()
      currentAuthor = replyMatch[1].trim()
      currentType = 'answer'
      if (!current.participants.includes(currentAuthor)) {
        current.participants.push(currentAuthor)
      }
      continue
    }

    // Context section starts the first message
    const ctxMatch = line.match(/^\*\*Context:\*\*\s*(.*)/)
    if (ctxMatch) {
      flushMessage()
      currentAuthor = current.participants[0] || 'author'
      currentType = 'question'
      msgLines.push(ctxMatch[1])
      continue
    }

    // Thread separator
    if (line.trim() === '---') {
      flushMessage()
      continue
    }

    msgLines.push(line)
  }

  flushMessage()
  return threads
}

// ── Handoff parser ───────────��───────────────────────────────────────────

interface ParsedHandoff {
  date: string
  commits: string[]
  decisions: string[]
  resumePoint: string
  looseEnds: string[]
}

export function parseHandoffFile(content: string): ParsedHandoff | null {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(content)
  } catch {
    return null
  }

  const raw = parsed.data.date
  const date =
    raw instanceof Date
      ? raw.toISOString().slice(0, 10)
      : raw
        ? String(raw).slice(0, 10)
        : new Date().toISOString().slice(0, 10)

  const body = parsed.content
  const sections = splitSections(body)

  return {
    date,
    commits: extractBullets(sections['what was done'] || sections['what was accomplished'] || ''),
    decisions: extractBullets(sections['decisions made'] || sections['decisions'] || ''),
    resumePoint: (sections['resume point'] || sections['open / next'] || '').trim(),
    looseEnds: extractBullets(sections['loose ends'] || sections['blockers'] || '')
  }
}

function splitSections(body: string): Record<string, string> {
  const result: Record<string, string> = {}
  const parts = body.split(/^## /m)
  for (const part of parts) {
    if (!part.trim()) continue
    const nlIdx = part.indexOf('\n')
    if (nlIdx === -1) continue
    const heading = part.slice(0, nlIdx).trim().toLowerCase()
    result[heading] = part.slice(nlIdx + 1)
  }
  return result
}

function extractBullets(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => /^\s*[-*]\s/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
}
