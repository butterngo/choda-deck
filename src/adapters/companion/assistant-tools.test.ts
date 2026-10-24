// TASK-2734 — the assistant's read-only tools, their redaction and their cap.
// Real binding (assistant-read-services) over fixture services, a temp vault and
// a temp meetings directory. No model is involved.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'
import { cap, redact } from './assistant-redact'
import { createAssistantTools } from './assistant-tools'
import { createAssistantReadServices, type AssistantTaskReads } from './assistant-read-services'
import { AssistantStore } from './assistant-store'

let tmp: string
let vaultDir: string
let artifactsDir: string
let db: Database.Database
let store: AssistantStore

const TASK = { id: 'TASK-1', title: 'A task', projectId: 'p', status: 'READY', priority: 'medium', body: '## Acceptance\n- [ ] x' }

/** Every read the binding may make, answered from fixtures. */
const READS: Record<string, (...args: unknown[]) => Promise<unknown>> = {
  findTasks: async () => [TASK],
  getTask: async (id) => (id === 'TASK-1' ? TASK : null),
  getSubtasks: async () => [],
  searchKnowledge: async () => ({ enabled: true, results: [{ slug: 'k', title: 'K', projectId: 'p' }] }),
  getKnowledge: async () => ({ slug: 'k', title: 'K', body: 'body' }),
  findInbox: async () => [],
  getConversation: async () => ({ id: 'CONV-1', title: 'c' }),
  getConversationMessages: async () => [],
  findSessions: async () => [],
  getProject: async () => null,
  findWorkspaces: async () => [],
  getRelationshipsFrom: async () => [],
  listSessionEvents: async () => []
}

/**
 * A task service whose read methods answer from READS and whose every OTHER
 * method — create, update, delete, anything — is a spy. If any tool reached a
 * write, a spy would record it.
 */
function spyingService(): { svc: AssistantTaskReads; writes: Map<string, ReturnType<typeof vi.fn>> } {
  const writes = new Map<string, ReturnType<typeof vi.fn>>()
  const svc = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop in READS) return READS[prop]
        if (prop === 'then') return undefined
        let spy = writes.get(prop)
        if (!spy) {
          spy = vi.fn()
          writes.set(prop, spy)
        }
        return spy
      }
    }
  ) as unknown as AssistantTaskReads
  return { svc, writes }
}

function tools(svc: AssistantTaskReads = spyingService().svc) {
  return createAssistantTools(
    createAssistantReadServices({
      svc,
      artifactsDir,
      vaultDir,
      store,
      dailyReport: async () => ({ date: '2026-10-24' })
    })
  )
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-tools-'))
  vaultDir = path.join(tmp, 'vault')
  artifactsDir = path.join(tmp, 'artifacts')
  fs.mkdirSync(path.join(vaultDir, '10-Projects', 'ichiba-devops'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '30-Knowledge'), { recursive: true })
  fs.mkdirSync(path.join(vaultDir, '20-Areas'), { recursive: true })
  fs.writeFileSync(path.join(vaultDir, '10-Projects', 'ichiba-devops', 'servers.md'), '# Servers\napi host 10.20.30.40\npassword: hunter2\nok\n')
  fs.writeFileSync(path.join(vaultDir, '20-Areas', 'private.md'), 'PRIVATE-AREA')
  fs.writeFileSync(path.join(tmp, 'outside.md'), 'OUTSIDE-SECRET')

  const meeting = path.join(artifactsDir, 'meetings', 'm-1')
  fs.mkdirSync(meeting, { recursive: true })
  fs.writeFileSync(
    path.join(meeting, 'meta.json'),
    JSON.stringify({ id: 'm-1', startedAt: '2026-10-20T08:00:00Z', endedAt: '2026-10-20T09:00:00Z', tracks: [], bytes: 0, title: 'Weekly sync' })
  )
  fs.writeFileSync(
    path.join(meeting, 'note.json'),
    JSON.stringify({ note: { tldr: 't', decisions: [{ text: 'Ship v2 on Friday', atMs: 1000 }], actions: [] } })
  )

  db = new Database(':memory:')
  initSchema(db)
  store = new AssistantStore(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('redact', () => {
  it('turns `host 10.20.30.40 ok` into `host [ip] ok`', () => {
    expect(redact('host 10.20.30.40 ok')).toBe('host [ip] ok')
  })

  it('turns a line `password: x` into `[line redacted]` and leaves the next line unchanged', () => {
    expect(redact('password: x\nnext line 1.2')).toBe('[line redacted]\nnext line 1.2')
  })
})

describe('cap', () => {
  it('cuts a 20000-character string to 16000 characters plus `\\n[truncated]`', () => {
    const out = cap('a'.repeat(20000))
    expect(out).toBe('a'.repeat(16000) + '\n[truncated]')
  })

  it('returns a 15999-character string unchanged', () => {
    const s = 'b'.repeat(15999)
    expect(cap(s)).toBe(s)
  })
})

describe('execute', () => {
  it("returns {\"error\":\"invalid arguments\"} for get_task with 'not json', without throwing", async () => {
    await expect(tools().execute('get_task', 'not json')).resolves.toBe('{"error":"invalid arguments"}')
  })

  it("returns {\"error\":\"unknown tool\"} for drop_tables", async () => {
    await expect(tools().execute('drop_tables', '{}')).resolves.toBe('{"error":"unknown tool"}')
  })

  it('read_vault_note refuses ../../etc/hosts and reads nothing outside the vault root', async () => {
    const t = tools()
    const a = JSON.parse(await t.execute('read_vault_note', '{"path":"../../etc/hosts"}')) as { error?: string }
    expect(a.error).toBeDefined()
    const b = await t.execute('read_vault_note', JSON.stringify({ path: '30-Knowledge/../../outside.md' }))
    expect(JSON.parse(b).error).toBeDefined()
    expect(b).not.toContain('OUTSIDE-SECRET')
    const c = await t.execute('read_vault_note', JSON.stringify({ path: '20-Areas/private.md' }))
    expect(c).not.toContain('PRIVATE-AREA')
  })

  it('read_vault_note returns a readable note redacted', async () => {
    const out = await tools().execute('read_vault_note', JSON.stringify({ path: '10-Projects/ichiba-devops/servers.md' }))
    expect(out).toContain('api host [ip]')
    expect(out).toContain('[line redacted]')
    expect(out).not.toContain('hunter2')
  })

  it("get_meeting for a meeting with a stored note returns that note's decisions", async () => {
    const out = JSON.parse(await tools().execute('get_meeting', '{"id":"m-1"}')) as {
      source: string
      decisions: unknown
    }
    expect(out.source).toBe('note')
    expect(out.decisions).toEqual([{ text: 'Ship v2 on Friday', atMs: 1000 }])
  })
})

describe('registry', () => {
  it('has exactly 15 tools', () => {
    expect(tools().definitions).toHaveLength(15)
  })

  it('keeps every function.description at most 1024 characters', () => {
    for (const d of tools().definitions) {
      expect(d.function.description.length, d.function.name).toBeLessThanOrEqual(1024)
    }
  })

  it('executing every tool once leaves every create/update/delete spy at zero calls', async () => {
    const { svc, writes } = spyingService()
    const t = tools(svc)
    const chat = store.createChat({ title: 'old' })
    store.appendMessage(chat.id, { role: 'user', content: 'ichiba servers' })
    const args: Record<string, unknown> = {
      search: { query: 'task' },
      get_task: { id: 'TASK-1' },
      list_tasks: {},
      search_knowledge: { query: 'k' },
      get_knowledge: { slug: 'k' },
      list_inbox: {},
      get_conversation: { id: 'CONV-1' },
      find_meetings: {},
      get_meeting: { id: 'm-1' },
      get_runs: {},
      get_daily_report: {},
      search_vault: { query: 'servers' },
      read_vault_note: { path: '10-Projects/ichiba-devops/servers.md' },
      search_chats: { query: 'ichiba' },
      get_chat: { id: chat.id }
    }
    const results: Record<string, string> = {}
    for (const d of t.definitions) {
      results[d.function.name] = await t.execute(d.function.name, JSON.stringify(args[d.function.name]))
    }
    // Every tool really ran (no error), so the zero below is not the zero of a tool that bailed early.
    for (const [name, out] of Object.entries(results)) {
      expect(out.startsWith('{"error"'), `${name}: ${out}`).toBe(false)
    }
    const called = [...writes.entries()].filter(([, spy]) => spy.mock.calls.length > 0).map(([n]) => n)
    expect(called).toEqual([])
  })
})
