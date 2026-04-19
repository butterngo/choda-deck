import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-conversation-poll__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-poll', 'Poll Project', '/tmp/poll')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('conversation_poll timestamp normalization', () => {
  it('finds messages regardless of ISO T vs space format', () => {
    svc.createConversation({
      id: 'CONV-POLL',
      projectId: 'proj-poll',
      title: 'Poll test',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' as const }]
    })

    svc.addConversationMessage({
      conversationId: 'CONV-POLL',
      authorName: 'Butter',
      content: 'message 1',
      messageType: 'question'
    })

    const messages = svc.getConversationMessages('CONV-POLL')
    expect(messages.length).toBeGreaterThan(0)

    const createdAt = messages[0].createdAt
    expect(createdAt).toContain(' ')
    expect(createdAt).not.toContain('T')

    const sinceISO = '2020-01-01T00:00:00Z'
    const sinceNorm = sinceISO.replace('T', ' ').replace('Z', '')
    const filtered = messages.filter((m) => m.createdAt > sinceNorm)
    expect(filtered.length).toBe(messages.length)
  })
})
