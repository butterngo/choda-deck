import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import { buildProjectContext } from '../mcp-tools/project-context-builder'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-ctx__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-ctx', 'Context Project', '/tmp/ctx')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('project_context openConversations', () => {
  it('includes recentMessages for open conversations', () => {
    const conv = svc.createConversation({
      id: 'CONV-CTX-1',
      projectId: 'proj-ctx',
      title: 'Open thread with messages',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' as const }]
    })

    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'Butter',
      content: 'first message',
      messageType: 'question'
    })
    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'Claude',
      content: 'second message',
      messageType: 'answer'
    })

    const bundle = buildProjectContext(svc, 'proj-ctx', 'summary')
    expect(bundle).not.toBeNull()

    const open = bundle!.currentState.openConversations
    expect(open.length).toBe(1)
    expect(open[0].id).toBe('CONV-CTX-1')
    expect(open[0].recentMessages.length).toBe(2)
    expect(open[0].recentMessages[0].author).toBe('Butter')
    expect(open[0].recentMessages[1].author).toBe('Claude')
  })

  it('recentMessages capped at last 3', () => {
    for (let i = 0; i < 5; i++) {
      svc.addConversationMessage({
        conversationId: 'CONV-CTX-1',
        authorName: `User${i}`,
        content: `msg ${i}`,
        messageType: 'comment'
      })
    }

    const bundle = buildProjectContext(svc, 'proj-ctx', 'summary')
    const open = bundle!.currentState.openConversations
    expect(open[0].recentMessages.length).toBe(3)
  })

  it('content truncated to 200 chars', () => {
    svc.createConversation({
      id: 'CONV-CTX-2',
      projectId: 'proj-ctx',
      title: 'Long message test',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' as const }]
    })

    // close first conv so we can open new one
    svc.updateConversation('CONV-CTX-1', { status: 'decided', decisionSummary: 'done' })
    svc.updateConversation('CONV-CTX-1', { status: 'closed', closedAt: new Date().toISOString() })

    const longContent = 'A'.repeat(500)
    svc.addConversationMessage({
      conversationId: 'CONV-CTX-2',
      authorName: 'Butter',
      content: longContent,
      messageType: 'question'
    })

    const bundle = buildProjectContext(svc, 'proj-ctx', 'summary')
    const open = bundle!.currentState.openConversations
    const msg = open.find((c) => c.id === 'CONV-CTX-2')
    expect(msg!.recentMessages[0].content.length).toBe(200)
  })

  it('returns null for unknown project', () => {
    expect(buildProjectContext(svc, 'nonexistent')).toBeNull()
  })
})
