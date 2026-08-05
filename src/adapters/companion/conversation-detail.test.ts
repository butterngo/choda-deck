// TASK-1568 — GET /conversations/:id. One test per acceptance criterion.
// The verbatim-content assertion uses a payload shaped like a real capture,
// because that markdown is the whole reason this route exists.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

// A capture-shaped body: markdown link target plus a URL, so a route that
// mangled or re-encoded content would show up here.
const CAPTURE_MD = '![capture](captures/ab12cd34ef56.png)\n\n(70 bytes)\n\nSource: http://ex.com/p?a=1&b=2'

const CONV = {
  id: 'CONV-7',
  projectId: 'choda-deck',
  title: 'Capture thread',
  status: 'open',
  createdBy: 'companion',
  decisionSummary: null,
  signedOff: [],
  createdAt: '2026-08-05T00:00:00.000Z',
  decidedAt: null
}

const MESSAGES = [
  {
    id: 'MSG-1',
    conversationId: 'CONV-7',
    authorName: 'companion',
    content: 'first turn',
    kind: 'message',
    readBy: [],
    createdAt: '2026-08-05T00:00:01.000Z'
  },
  {
    id: 'MSG-2',
    conversationId: 'CONV-7',
    authorName: 'companion',
    content: CAPTURE_MD,
    kind: 'message',
    readBy: [],
    createdAt: '2026-08-05T00:00:02.000Z'
  }
]

const PARTICIPANTS = [{ conversationId: 'CONV-7', name: 'companion' }]

const fakeSvc = {
  listProjects: async () => [{ id: 'choda-deck' }],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [CONV],
  findWorkspaces: async () => [],
  getConversation: async (id: string) => (id === 'CONV-7' ? CONV : null),
  getConversationMessages: async () => MESSAGES,
  getConversationParticipants: async () => PARTICIPANTS
} as unknown as BackendTaskService

let handle: CompanionServerHandle
let base: string
const db = new Database(':memory:')

beforeAll(async () => {
  const services = {
    svc: fakeSvc,
    db,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: 'tok',
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => db.close()
  } as unknown as CompanionServices
  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle.close()
})

describe('GET /conversations/:id', () => {
  it('AC-1: returns the domain Conversation under `conversation`', async () => {
    const r = await fetch(`${base}/conversations/CONV-7`)
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.conversation).toEqual(CONV)
  })

  it('AC-2: messages are domain ConversationMessage objects with authorName', async () => {
    const body = await (await fetch(`${base}/conversations/CONV-7`)).json()
    expect(Array.isArray(body.messages)).toBe(true)
    expect(Object.keys(body.messages[0]).sort()).toEqual(
      ['authorName', 'content', 'conversationId', 'createdAt', 'id', 'kind', 'readBy'].sort()
    )
  })

  it('AC-3: participants are domain ConversationParticipant objects', async () => {
    const body = await (await fetch(`${base}/conversations/CONV-7`)).json()
    expect(body.participants).toEqual(PARTICIPANTS)
  })

  it('AC-4: messages are oldest-first and content survives byte-identical', async () => {
    const body = await (await fetch(`${base}/conversations/CONV-7`)).json()
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['MSG-1', 'MSG-2'])
    // The capture markdown is the payload TASK-1570 renders — any escaping or
    // re-encoding here would silently break the image link downstream.
    expect(body.messages[1].content).toBe(CAPTURE_MD)
  })

  it('AC-5: unknown id → 404 JSON, not 200 with a null conversation', async () => {
    const r = await fetch(`${base}/conversations/CONV-nope`)
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toBe('application/json')
    const body = await r.json()
    expect(body.error).toContain('CONV-nope')
    expect(body.conversation).toBeUndefined()
  })

  it('AC-6: the list route is unchanged', async () => {
    const r = await fetch(`${base}/conversations`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ conversations: [CONV] })
  })

  it('AC-7: POST /conversations/:id → 405', async () => {
    const r = await fetch(`${base}/conversations/CONV-7`, { method: 'POST' })
    expect(r.status).toBe(405)
  })

  it('an encoded id round-trips through decodeURIComponent', async () => {
    const r = await fetch(`${base}/conversations/CONV%2Dnope`)
    expect(r.status).toBe(404)
    expect((await r.json()).error).toContain('CONV-nope')
  })
})
