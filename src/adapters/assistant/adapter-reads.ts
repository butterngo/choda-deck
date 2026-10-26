// TASK-2756 — the assistant service reads Butter's work data only through the
// companion adapter's read routes (Butter, discovery CONV-1792980384690-64,
// round 1). The adapter stays the one owner of the task database; this module
// never opens it, and every call it makes is a GET.
//
//   search            GET /search?q=&limit=
//   get_task          GET /tasks/:id
//   list_tasks        GET /tasks?projectId=&status=&limit=   (title words filtered here)
//   search_knowledge  GET /knowledge/search?q=&topK=
//   get_knowledge     GET /knowledge/:slug
//   list_inbox        GET /inbox                              (filtered here)
//   get_conversation  GET /conversations/:id
//   find_meetings     GET /meetings
//   get_meeting       GET /meetings + GET /artifacts/meetings/:id/{note,transcript}.json
//   get_runs          GET /runs
//   get_daily_report  GET /daily-report?date=
//   search_vault      GET /vault/search?q=&limit=
//   read_vault_note   GET /vault/note?path=   (10-Projects, 30-Knowledge, .md only)
//   search_chats, get_chat — the service's own store
//
// An adapter that does not answer, answers late or answers 5xx is reported as
// `adapter unavailable`; a 4xx (an unknown task id included) carries the
// adapter's own `error` text. Both come back to the model as a tool error, and
// the loop carries on.

import type { AssistantReadServices } from './tools'
import type { ChatStore } from './chat-store'

export const ADAPTER_TIMEOUT_MS = 10_000
const MEETING_ID = /^[A-Za-z0-9_-]{1,64}$/
const READABLE_PREFIXES = ['10-Projects/', '30-Knowledge/']

export interface AdapterReadsDeps {
  adapterUrl: string
  bridgeToken: string
  store: ChatStore | null
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

class AdapterNotFound extends Error {}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
}

export function createAdapterReads(deps: AdapterReadsDeps): AssistantReadServices {
  const base = deps.adapterUrl.replace(/\/+$/, '')
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? ADAPTER_TIMEOUT_MS

  async function request(path: string): Promise<Response> {
    let res: Response
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: 'GET',
        headers: { 'x-choda-bridge-token': deps.bridgeToken },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw new Error('adapter unavailable')
    }
    if (res.status >= 500) throw new Error('adapter unavailable')
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new AdapterNotFound(body?.error ?? 'not found')
    }
    if (res.status >= 400) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `adapter answered ${res.status}`)
    }
    return res
  }

  async function getJson<T>(path: string): Promise<T> {
    const res = await request(path)
    try {
      return (await res.json()) as T
    } catch {
      throw new Error('adapter unavailable')
    }
  }

  /** For files that may legitimately be absent (a meeting with no note yet): a 404 is null. */
  async function getText(path: string): Promise<string | null> {
    try {
      return await (await request(path)).text()
    } catch (err) {
      if (err instanceof AdapterNotFound) return null
      throw err
    }
  }

  const q = (params: Record<string, string | number | undefined>): string => {
    const s = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) s.set(k, String(v))
    const text = s.toString()
    return text === '' ? '' : `?${text}`
  }
  const id = (v: string): string => encodeURIComponent(v)

  interface MeetingMeta {
    id: string
    title?: string | null
    startedAt?: string
    endedAt?: string | null
    transcribedAt?: string | null
  }

  return {
    async search(query, limit) {
      return getJson(`/search${q({ q: query, limit })}`)
    },

    async getTask(taskId) {
      return getJson(`/tasks/${id(taskId)}`)
    },

    async listTasks(filter) {
      const r = await getJson<{ tasks: { title?: string }[] }>(
        `/tasks${q({ projectId: filter.projectId, status: filter.status, limit: filter.query ? undefined : filter.limit })}`
      )
      const want = filter.query ? words(filter.query) : []
      const rows = want.length === 0 ? r.tasks : r.tasks.filter((t) => want.every((w) => (t.title ?? '').toLowerCase().includes(w)))
      return rows.slice(0, filter.limit)
    },

    async searchKnowledge(query, limit) {
      return getJson(`/knowledge/search${q({ q: query, topK: limit })}`)
    },

    async getKnowledge(slug) {
      return getJson(`/knowledge/${id(slug)}`)
    },

    async listInbox(filter) {
      const r = await getJson<{
        inbox: { id: string; projectId: string | null; status: string; createdAt: string; content: string }[]
      }>('/inbox')
      return r.inbox
        .filter((i) => filter.projectId === undefined || i.projectId === filter.projectId)
        .filter((i) => filter.status === undefined || i.status === filter.status)
        .slice(0, filter.limit)
        .map((i) => ({ id: i.id, projectId: i.projectId, status: i.status, createdAt: i.createdAt, content: i.content }))
    },

    async getConversation(convId) {
      const r = await getJson<{
        conversation: Record<string, unknown>
        messages: { authorName?: string; createdAt?: string; content?: string }[]
      }>(`/conversations/${id(convId)}`)
      return {
        ...r.conversation,
        messages: (r.messages ?? []).map((m) => ({ author: m.authorName, at: m.createdAt, content: m.content }))
      }
    },

    async findMeetings(query, limit) {
      const all = await getJson<MeetingMeta[]>('/meetings')
      const want = query ? words(query) : []
      return all
        .filter((m) => want.every((w) => (m.title ?? '').toLowerCase().includes(w)))
        .slice(0, limit)
        .map((m) => ({ id: m.id, title: m.title ?? null, startedAt: m.startedAt, transcribed: Boolean(m.transcribedAt) }))
    },

    async getMeeting(meetingId) {
      if (!MEETING_ID.test(meetingId)) return null
      const meta = (await getJson<MeetingMeta[]>('/meetings')).find((m) => m.id === meetingId)
      if (!meta) return null
      const head = { id: meta.id, title: meta.title ?? null, startedAt: meta.startedAt, endedAt: meta.endedAt ?? null }
      const note = await getText(`/artifacts/meetings/${id(meetingId)}/note.json`)
      if (note !== null) {
        try {
          const stored = JSON.parse(note) as { note?: Record<string, unknown> }
          if (stored.note) return { ...head, source: 'note', ...stored.note }
        } catch {
          // unreadable note — fall back to the transcript
        }
      }
      const raw = await getText(`/artifacts/meetings/${id(meetingId)}/transcript.json`)
      if (raw === null) return { ...head, source: 'none', note: 'not transcribed yet' }
      try {
        const t = JSON.parse(raw) as { segments?: { speaker?: string; text?: string }[] }
        const transcript = (t.segments ?? []).map((s) => `${s.speaker ?? '?'}: ${s.text ?? ''}`).join('\n')
        return { ...head, source: 'transcript', transcript }
      } catch {
        return { ...head, source: 'none', note: 'transcript unreadable' }
      }
    },

    async getRuns(goalId) {
      const { runs } = await getJson<{
        runs: {
          goal: { id: string }
          state: unknown
          stage: unknown
          items: { id: string; title: string; status: string; activeSince: string | null }[]
          lastActivityAt: unknown
          prUrls: unknown
        }[]
      }>('/runs')
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
      return getJson(`/daily-report${q({ date })}`)
    },

    async searchVault(query, limit) {
      return getJson(`/vault/search${q({ q: query, limit })}`)
    },

    async readVaultNote(rel) {
      // Refused here too, before any request: a path outside the two readable
      // folders never leaves the service. The adapter enforces the same rule.
      const norm = rel.replace(/\\/g, '/')
      if (!READABLE_PREFIXES.some((p) => norm.startsWith(p))) throw new Error('path not readable')
      return getText(`/vault/note${q({ path: norm })}`)
    },

    async searchChats(query, limit) {
      if (!deps.store) throw new Error('chat history unavailable')
      return deps.store.searchChats(query, limit)
    },

    async getChat(chatId) {
      if (!deps.store) throw new Error('chat history unavailable')
      const chat = deps.store.getChat(chatId)
      if (!chat) return null
      return {
        chat,
        messages: deps.store
          .listMessages(chatId)
          .filter((m) => m.role !== 'tool')
          .map((m) => ({ role: m.role, content: m.content, at: m.createdAt }))
      }
    }
  }
}
