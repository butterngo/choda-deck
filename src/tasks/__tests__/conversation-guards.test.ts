import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-guards__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-g', 'Guard Project', '/tmp/g')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

function openConv(id: string, title: string) {
  return svc.createConversation({
    id,
    projectId: 'proj-g',
    title,
    createdBy: 'Butter',
    participants: [{ name: 'Butter', type: 'human' as const }]
  })
}

describe('conversation guards', () => {
  it('only 1 open/discussing per project', () => {
    const conv = openConv('CONV-G1', 'First thread')
    expect(conv.status).toBe('open')

    const discussing = [
      ...svc.findConversations('proj-g', 'open'),
      ...svc.findConversations('proj-g', 'discussing')
    ]
    expect(discussing.length).toBe(1)

    // move to decided so next tests work
    svc.updateConversation('CONV-G1', {
      status: 'decided',
      decisionSummary: 'test decision'
    })
  })

  it('cannot open new thread when decided exists unclosed', () => {
    const decided = svc.findConversations('proj-g', 'decided')
    expect(decided.length).toBeGreaterThan(0)
  })

  it('conversation_close: decided → closed', () => {
    svc.updateConversation('CONV-G1', { status: 'closed', closedAt: new Date().toISOString() })
    const conv = svc.getConversation('CONV-G1')!
    expect(conv.status).toBe('closed')
    expect(conv.closedAt).toBeTruthy()
  })

  it('can open new thread after closing decided', () => {
    const decided = svc.findConversations('proj-g', 'decided')
    const active = [
      ...svc.findConversations('proj-g', 'open'),
      ...svc.findConversations('proj-g', 'discussing')
    ]
    expect(decided.length).toBe(0)
    expect(active.length).toBe(0)

    const conv = openConv('CONV-G2', 'Second thread')
    expect(conv.status).toBe('open')

    svc.updateConversation('CONV-G2', {
      status: 'decided',
      decisionSummary: 'done'
    })
  })

  it('conversation_reopen: decided → discussing', () => {
    const before = svc.getConversation('CONV-G2')!
    expect(before.status).toBe('decided')

    svc.updateConversation('CONV-G2', { status: 'discussing' })
    const after = svc.getConversation('CONV-G2')!
    expect(after.status).toBe('discussing')
  })

  it('cannot reopen if another thread is active', () => {
    // CONV-G2 is discussing
    svc.updateConversation('CONV-G2', { status: 'decided', decisionSummary: 'done again' })

    // close G1 already closed, open G3
    openConv('CONV-G3', 'Third thread')
    const active = [
      ...svc.findConversations('proj-g', 'open'),
      ...svc.findConversations('proj-g', 'discussing')
    ]
    expect(active.length).toBe(1)
    expect(active[0].id).toBe('CONV-G3')

    // cleanup
    svc.updateConversation('CONV-G3', { status: 'decided', decisionSummary: 'x' })
    svc.updateConversation('CONV-G3', { status: 'closed', closedAt: new Date().toISOString() })
    svc.updateConversation('CONV-G2', { status: 'closed', closedAt: new Date().toISOString() })
  })
})

describe('conversation_poll timestamp normalization', () => {
  it('finds messages regardless of ISO T vs space format', () => {
    openConv('CONV-POLL', 'Poll test')

    svc.addConversationMessage({
      conversationId: 'CONV-POLL',
      authorName: 'Butter',
      content: 'message 1',
      messageType: 'question'
    })

    // createdAt in DB uses space format: "2026-04-16 10:00:00"
    const messages = svc.getConversationMessages('CONV-POLL')
    expect(messages.length).toBeGreaterThan(0)

    const createdAt = messages[0].createdAt // space format
    expect(createdAt).toContain(' ') // "YYYY-MM-DD HH:MM:SS"
    expect(createdAt).not.toContain('T')

    // query with ISO format (T separator) should still work after normalization
    const sinceISO = '2020-01-01T00:00:00Z'
    const sinceNorm = sinceISO.replace('T', ' ').replace('Z', '')
    const filtered = messages.filter((m) => m.createdAt > sinceNorm)
    expect(filtered.length).toBe(messages.length)

    // cleanup
    svc.updateConversation('CONV-POLL', { status: 'decided', decisionSummary: 'poll test done' })
    svc.updateConversation('CONV-POLL', { status: 'closed', closedAt: new Date().toISOString() })
  })
})
