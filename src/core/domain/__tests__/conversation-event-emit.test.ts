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

  it('does NOT emit for comment / proposal / review / action message types', () => {
    svc.createConversation({
      id: 'CONV-NONROUTING',
      projectId: PROJECT_ID,
      title: 'role convo',
      createdBy: 'BE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-NONROUTING',
      authorName: 'BE',
      content: 'just a note',
      messageType: 'comment'
    })
    svc.addConversationMessage({
      conversationId: 'CONV-NONROUTING',
      authorName: 'BE',
      content: 'a proposal',
      messageType: 'proposal'
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

  it('Phase 1 question events tagged with type=message.question', () => {
    svc.createConversation({
      id: 'CONV-Q-TYPE',
      projectId: PROJECT_ID,
      title: 'type tag',
      createdBy: 'FE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-Q-TYPE',
      authorName: 'FE',
      content: 'q',
      messageType: 'question'
    })
    const event = JSON.parse(eventLines()[0])
    expect(event.type).toBe('message.question')
  })
})

describe('conversation event emit — Phase 2: message.answer', () => {
  it('emits message.answer when role-routed', () => {
    svc.openConversation({
      projectId: PROJECT_ID,
      title: 'q-and-a',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ],
      initialMessage: { content: 'why?', type: 'question' }
    })
    const conv = svc.findConversations(PROJECT_ID)[0]
    fs.writeFileSync(path.join(EVENT_DIR, `${PROJECT_ID}.jsonl`), '') // reset after open
    svc.addConversationMessage({
      conversationId: conv.id,
      authorName: 'BE',
      content: 'because flag X',
      messageType: 'answer'
    })
    const events = eventLines().map((l) => JSON.parse(l))
    expect(events.some((e) => e.type === 'message.answer' && e.author === 'BE')).toBe(true)
  })
})

describe('conversation event emit — Phase 2: targetRole filter', () => {
  it('routes only to targetRole when set', () => {
    svc.createConversation({
      id: 'CONV-TARGET',
      projectId: PROJECT_ID,
      title: 'targeted',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' },
        { name: 'QA', type: 'role' as const, role: 'QA' }
      ]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-TARGET',
      authorName: 'FE',
      content: 'BE only',
      messageType: 'question',
      targetRole: 'BE'
    })
    const event = JSON.parse(eventLines()[0])
    expect(event.roles).toEqual(['BE'])
  })

  it('skips emit when targetRole is not a participant', () => {
    svc.createConversation({
      id: 'CONV-MISS',
      projectId: PROJECT_ID,
      title: 'missing target',
      createdBy: 'FE',
      participants: [{ name: 'FE', type: 'role' as const, role: 'FE' }]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-MISS',
      authorName: 'FE',
      content: 'BE only',
      messageType: 'question',
      targetRole: 'BE'
    })
    expect(eventLines()).toEqual([])
  })

  it('falls back to all roles when targetRole is null', () => {
    svc.createConversation({
      id: 'CONV-ALL',
      projectId: PROJECT_ID,
      title: 'broadcast',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ]
    })
    svc.addConversationMessage({
      conversationId: 'CONV-ALL',
      authorName: 'FE',
      content: 'broadcast',
      messageType: 'question'
    })
    const event = JSON.parse(eventLines()[0])
    expect(event.roles.sort()).toEqual(['BE', 'FE'])
  })
})

describe('conversation event emit — Phase 2: lifecycle events', () => {
  it('emits conversation.open on openConversation', () => {
    svc.openConversation({
      projectId: PROJECT_ID,
      title: 'opener',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ],
      initialMessage: { content: 'kickoff', type: 'question' }
    })
    const events = eventLines().map((l) => JSON.parse(l))
    const open = events.find((e) => e.type === 'conversation.open')
    expect(open).toBeDefined()
    expect(open.author).toBe('FE')
    expect(open.roles.sort()).toEqual(['BE', 'FE'])
  })

  it('emits conversation.open BEFORE the initial message.question event', () => {
    svc.openConversation({
      projectId: PROJECT_ID,
      title: 'order check',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ],
      initialMessage: { content: 'q', type: 'question' }
    })
    const types = eventLines().map((l) => JSON.parse(l).type)
    const openIdx = types.indexOf('conversation.open')
    const qIdx = types.indexOf('message.question')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(qIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBeLessThan(qIdx)
  })

  it('emits conversation.decide on decideConversation', () => {
    const conv = svc.openConversation({
      projectId: PROJECT_ID,
      title: 'decide-me',
      createdBy: 'FE',
      participants: [
        { name: 'FE', type: 'role' as const, role: 'FE' },
        { name: 'BE', type: 'role' as const, role: 'BE' }
      ],
      initialMessage: { content: 'pick one', type: 'proposal' }
    })
    fs.writeFileSync(path.join(EVENT_DIR, `${PROJECT_ID}.jsonl`), '')
    svc.decideConversation(conv.id, { author: 'BE', decision: 'go with A' })
    const events = eventLines().map((l) => JSON.parse(l))
    const decide = events.find((e) => e.type === 'conversation.decide')
    expect(decide).toBeDefined()
    expect(decide.author).toBe('BE')
  })

  it('emits conversation.close on closeConversation', () => {
    const conv = svc.openConversation({
      projectId: PROJECT_ID,
      title: 'close-me',
      createdBy: 'FE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }],
      initialMessage: { content: 'q', type: 'question' }
    })
    svc.decideConversation(conv.id, { author: 'BE', decision: 'done' })
    fs.writeFileSync(path.join(EVENT_DIR, `${PROJECT_ID}.jsonl`), '')
    svc.closeConversation(conv.id)
    const events = eventLines().map((l) => JSON.parse(l))
    const close = events.find((e) => e.type === 'conversation.close')
    expect(close).toBeDefined()
    expect(close.author).toBe('system')
  })

  it('emits conversation.reopen on reopenConversation', () => {
    const conv = svc.openConversation({
      projectId: PROJECT_ID,
      title: 'reopen-me',
      createdBy: 'FE',
      participants: [{ name: 'BE', type: 'role' as const, role: 'BE' }],
      initialMessage: { content: 'q', type: 'question' }
    })
    svc.decideConversation(conv.id, { author: 'BE', decision: 'done' })
    fs.writeFileSync(path.join(EVENT_DIR, `${PROJECT_ID}.jsonl`), '')
    svc.reopenConversation(conv.id)
    const events = eventLines().map((l) => JSON.parse(l))
    const reopen = events.find((e) => e.type === 'conversation.reopen')
    expect(reopen).toBeDefined()
    expect(reopen.author).toBe('system')
  })

  it('skips lifecycle events when conversation has no role-bearing participants', () => {
    const conv = svc.openConversation({
      projectId: PROJECT_ID,
      title: 'no-roles',
      createdBy: 'Butter',
      participants: [{ name: 'Butter', type: 'human' as const }],
      initialMessage: { content: 'q', type: 'question' }
    })
    svc.decideConversation(conv.id, { author: 'Butter', decision: 'done' })
    svc.closeConversation(conv.id)
    expect(eventLines()).toEqual([])
  })
})
