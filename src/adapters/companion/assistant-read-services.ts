// TASK-2734 — binds the assistant's read-only tool surface (AssistantReadServices)
// to the real data: the task service, meeting artifacts, the vault and the chat
// store. Only read methods of the task service are named in the type below, so a
// write cannot be reached from here without changing this type first.

import * as fs from 'fs'
import * as path from 'path'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { AssistantReadServices } from './assistant-tools'
import type { AssistantStore } from './assistant-store'
import { listMeetings, readMeta, MEETINGS_DIR } from './meetings'
import { NOTE_FILE } from './meeting-files'
import { buildRuns, type RunsDeps } from './runs'
import { safeResolve } from './vault'

/** The task-service methods the assistant may call. All of them read. */
export type AssistantTaskReads = Pick<
  BackendTaskService,
  'findTasks' | 'getTask' | 'getSubtasks' | 'searchKnowledge' | 'getKnowledge' | 'findInbox' | 'getConversation' | 'getConversationMessages'
> &
  RunsDeps['svc']

export interface AssistantReadDeps {
  svc: AssistantTaskReads
  artifactsDir?: string
  /** Absent → the vault tools answer "vault not configured". */
  vaultDir?: string
  store: AssistantStore | null
  /** The daily report, built by the caller (it owns the git scan cache). */
  dailyReport?: (date: string | undefined) => Promise<unknown>
}

/** The two vault folders the assistant may read. 20-Areas (personal) is never reachable. */
export const VAULT_READABLE_DIRS = ['10-Projects', '30-Knowledge'] as const
const VAULT_MAX_FILES = 3000
const MEETING_ID = /^[A-Za-z0-9_-]{1,64}$/
const SNIPPET = 160

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

function* markdownFiles(root: string, rel = ''): Generator<string> {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const child = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) yield* markdownFiles(root, child)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) yield child
  }
}

export function createAssistantReadServices(deps: AssistantReadDeps): AssistantReadServices {
  const { svc } = deps
  return {
    async search(query, limit) {
      const tasks = await svc.findTasks({ query, limit })
      const kn = await svc.searchKnowledge(query, limit)
      return {
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status })),
        knowledge: kn.enabled ? kn.results.map((k) => ({ slug: k.slug, title: k.title, projectId: k.projectId })) : [],
        knowledgeSearch: kn.enabled ? 'on' : `off: ${kn.reason ?? 'unavailable'}`
      }
    },

    async getTask(id) {
      const task = await svc.getTask(id)
      if (!task) return null
      const subtasks = await svc.getSubtasks(id)
      return {
        ...task,
        subtasks: subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status }))
      }
    },

    async listTasks(filter) {
      const rows = await svc.findTasks({
        projectId: filter.projectId,
        status: filter.status as never,
        query: filter.query,
        limit: filter.limit
      })
      return rows.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status, priority: t.priority }))
    },

    async searchKnowledge(query, limit) {
      return svc.searchKnowledge(query, limit)
    },

    async getKnowledge(slug) {
      return svc.getKnowledge(slug)
    },

    async listInbox(filter) {
      const rows = await svc.findInbox({ projectId: filter.projectId, status: filter.status as never })
      return rows.slice(0, filter.limit).map((i) => ({
        id: i.id,
        projectId: i.projectId,
        status: i.status,
        createdAt: i.createdAt,
        content: i.content
      }))
    },

    async getConversation(id) {
      const conv = await svc.getConversation(id)
      if (!conv) return null
      const messages = await svc.getConversationMessages(id)
      return {
        ...conv,
        messages: messages.map((m) => ({ author: m.authorName, at: m.createdAt, content: m.content }))
      }
    },

    async findMeetings(query, limit) {
      if (!deps.artifactsDir) throw new Error('meetings not configured')
      const q = query ? words(query) : []
      return listMeetings(deps.artifactsDir)
        .filter((m) => q.every((w) => (m.title ?? '').toLowerCase().includes(w)))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          title: m.title ?? null,
          startedAt: m.startedAt,
          transcribed: Boolean(m.transcribedAt),
          hasNote: fs.existsSync(path.join(deps.artifactsDir as string, MEETINGS_DIR, m.id, NOTE_FILE))
        }))
    },

    async getMeeting(id) {
      if (!deps.artifactsDir) throw new Error('meetings not configured')
      if (!MEETING_ID.test(id)) return null
      const meta = readMeta(deps.artifactsDir, id)
      if (!meta) return null
      const dir = path.join(deps.artifactsDir, MEETINGS_DIR, id)
      const head = { id: meta.id, title: meta.title ?? null, startedAt: meta.startedAt, endedAt: meta.endedAt }
      try {
        const stored = JSON.parse(fs.readFileSync(path.join(dir, NOTE_FILE), 'utf8')) as {
          note?: Record<string, unknown>
        }
        if (stored.note) return { ...head, source: 'note', ...stored.note }
      } catch {
        // no stored note — fall back to the transcript
      }
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')) as {
          segments?: { speaker?: string; text?: string }[]
        }
        const transcript = (t.segments ?? []).map((s) => `${s.speaker ?? '?'}: ${s.text ?? ''}`).join('\n')
        return { ...head, source: 'transcript', transcript }
      } catch {
        return { ...head, source: 'none', note: 'not transcribed yet' }
      }
    },

    async getRuns(goalId) {
      const { runs } = await buildRuns(svc)
      return runs
        .filter((r) => goalId === undefined || r.goal.id === goalId)
        .map((r) => {
          const done = r.items.filter((i) => i.status === 'IMPLEMENTED' || i.status === 'DONE').length
          const current = r.items.find((i) => i.activeSince !== null) ?? r.items.find((i) => i.status === 'IN-PROGRESS')
          return {
            goal: r.goal,
            state: r.state,
            stage: r.stage,
            itemsDone: done,
            itemsTotal: r.items.length,
            currentItem: current ? { id: current.id, title: current.title, status: current.status } : null,
            lastActivityAt: r.lastActivityAt,
            prUrls: r.prUrls
          }
        })
    },

    async getDailyReport(date) {
      if (!deps.dailyReport) throw new Error('daily report not configured')
      return deps.dailyReport(date)
    },

    async searchVault(query, limit) {
      if (!deps.vaultDir) throw new Error('vault not configured')
      const q = words(query)
      const hits: { path: string; snippet: string }[] = []
      let seen = 0
      for (const dir of VAULT_READABLE_DIRS) {
        const root = path.resolve(deps.vaultDir, dir)
        for (const rel of markdownFiles(root)) {
          if (++seen > VAULT_MAX_FILES || hits.length >= limit) break
          const full = `${dir}/${rel}`
          let text: string
          try {
            text = fs.readFileSync(path.join(root, rel), 'utf8')
          } catch {
            continue
          }
          const hay = `${full}\n${text}`.toLowerCase()
          if (!q.every((w) => hay.includes(w))) continue
          const at = Math.max(0, text.toLowerCase().indexOf(q[0] ?? ''))
          hits.push({ path: full, snippet: text.slice(Math.max(0, at - 40), at + SNIPPET).replace(/\s+/g, ' ') })
        }
      }
      return hits
    },

    async readVaultNote(rel) {
      if (!deps.vaultDir) throw new Error('vault not configured')
      const norm = rel.replace(/\\/g, '/')
      const top = VAULT_READABLE_DIRS.find((d) => norm.startsWith(`${d}/`))
      if (!top) return null
      const target = safeResolve(path.resolve(deps.vaultDir, top), norm.slice(top.length + 1))
      if (target === null || !target.toLowerCase().endsWith('.md')) return null
      try {
        return fs.readFileSync(target, 'utf8')
      } catch {
        return null
      }
    },

    async searchChats(query, limit) {
      if (!deps.store) throw new Error('chat history unavailable')
      return deps.store.searchChats(query, limit)
    },

    async getChat(id) {
      if (!deps.store) throw new Error('chat history unavailable')
      const chat = deps.store.getChat(id)
      if (!chat) return null
      return {
        chat,
        messages: deps.store
          .listMessages(id)
          .filter((m) => m.role !== 'tool')
          .map((m) => ({ role: m.role, content: m.content, at: m.createdAt }))
      }
    }
  }
}
