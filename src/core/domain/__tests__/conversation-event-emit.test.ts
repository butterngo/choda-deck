import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'

const TMP_ROOT = path.join(os.tmpdir(), 'choda-test-event-emit')
const TEST_DB = path.join(TMP_ROOT, 'event-emit.db')
const EVENT_DIR = path.join(TMP_ROOT, 'events')
const PROJECT_ID = 'proj-evt'

let svc: SqliteTaskService
let savedEventDir: string | undefined

function eventLines(): string[] {
  const file = path.join(EVENT_DIR, `${PROJECT_ID}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

beforeEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  fs.mkdirSync(TMP_ROOT, { recursive: true })
  savedEventDir = process.env.CHODA_EVENT_DIR
  process.env.CHODA_EVENT_DIR = EVENT_DIR
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject(PROJECT_ID, 'Event emit test', '/tmp/evt')
})

afterEach(() => {
  svc.close()
  if (savedEventDir === undefined) delete process.env.CHODA_EVENT_DIR
  else process.env.CHODA_EVENT_DIR = savedEventDir
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe('conversation event emit — filter logic', () => {
  it('emits when messageType=question AND a participant has a non-null role', () => {
    svc.createConversation({
      id: 'CONV-Q-ROLE',
      projectId: PROJECT_ID,
      title: 'FE asks BE',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-Q-ROLE',
      authorName: 'FE',
      content: 'why is node disabled?',
      messageType: 'question'
    })
    const lines = eventLines()
    expect(lines.length).toBe(1)
    const event = JSON.parse(lines[0])
    expect(event).toMatchObject({
      conversationId: 'CONV-Q-ROLE',
      messageType: 'question',
      author: 'FE'
    })
    expect(event.roles.sort()).toEqual(['BE', 'FE'])
    expect(typeof event.timestamp).toBe('string')
  })

  it('does NOT emit for non-question message types (answer, comment, …)', () => {
    svc.createConversation({
      id: 'CONV-ANSWER',
      projectId: PROJECT_ID,
      title: 'role convo',
      createdBy: 'BE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-ANSWER',
      authorName: 'BE',
      content: 'because flag X',
      messageType: 'answer'
    })
    svc.addConversationMessage({
      conversationId: 'CONV-ANSWER',
      authorName: 'BE',
      content: 'just a note',
      messageType: 'comment'
    })
    expect(eventLines()).toEqual([])
  })

  it('does NOT emit when no participant has a non-null role', () => {
    svc.createConversation({
      id: 'CONV-NO-ROLE',
      projectId: PROJECT_ID,
      title: 'human convo',
      createdBy: 'Butter',
      participants: [
        { name: 'Butter', type: 'human' as const },
        { name: 'Claude', type: 'ai' as const }
      ]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-NO-ROLE',
      authorName: 'Butter',
      content: 'question without a role target',
      messageType: 'question'
    })
    expect(eventLines()).toEqual([])
  })

  it('appends one line per qualifying question across multiple calls', () => {
    svc.createConversation({
      id: 'CONV-MULTI',
      projectId: PROJECT_ID,
      title: 'multi',
      createdBy: 'FE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-MULTI',
      authorName: 'FE',
      content: 'q1',
      messageType: 'question'
    })
    svc.addConversationMessage({
      conversationId: 'CONV-MULTI',
      authorName: 'FE',
      content: 'q2',
      messageType: 'question'
    })
    const lines = eventLines()
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).conversationId).toBe('CONV-MULTI')
    expect(JSON.parse(lines[1]).conversationId).toBe('CONV-MULTI')
  })
})
