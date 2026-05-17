import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { initSchema } from '../schema'
import { ProjectRepository } from '../project-repository'
import { SessionRepository } from '../session-repository'
import { SessionEventRepository } from '../session-event-repository'

let tmpDir: string
let db: Database.Database
let sessions: SessionRepository
let events: SessionEventRepository

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-evt-repo-'))
  db = new Database(path.join(tmpDir, 'test.db'))
  initSchema(db)
  const projects = new ProjectRepository(db)
  projects.ensure('p1', 'Project One', 'C:\\dev\\p1')
  sessions = new SessionRepository(db)
  events = new SessionEventRepository(db)
  sessions.create({ id: 'S1', projectId: 'p1' })
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionEventRepository.create', () => {
  it('inserts and returns the event', () => {
    const evt = events.create({ sessionId: 'S1', eventType: 'decision' })
    expect(evt.sessionId).toBe('S1')
    expect(evt.eventType).toBe('decision')
    expect(evt.memoryCandidate).toBe(false)
    expect(evt.payloadJson).toBeNull()
    expect(evt.id).toBeTruthy()
    expect(evt.createdAt).toBeTruthy()
  })

  it('stores payloadJson and memoryCandidate=true', () => {
    const evt = events.create({
      sessionId: 'S1',
      eventType: 'tool_call',
      payloadJson: '{"tool":"bash"}',
      memoryCandidate: true
    })
    expect(evt.payloadJson).toBe('{"tool":"bash"}')
    expect(evt.memoryCandidate).toBe(true)
  })

  it('rejects unknown session_id when foreign keys are enabled', () => {
    db.pragma('foreign_keys = ON')
    expect(() =>
      events.create({ sessionId: 'NO-SUCH-SESSION', eventType: 'observation' })
    ).toThrow()
  })
})

describe('SessionEventRepository.listBySession', () => {
  it('returns all events for the session ordered by created_at ASC', () => {
    events.create({ sessionId: 'S1', eventType: 'observation' })
    events.create({ sessionId: 'S1', eventType: 'tool_call' })
    events.create({ sessionId: 'S1', eventType: 'decision' })
    const list = events.listBySession('S1')
    expect(list).toHaveLength(3)
    expect(list.map((e) => e.eventType)).toEqual(['observation', 'tool_call', 'decision'])
  })

  it('returns [] for an unknown sessionId', () => {
    expect(events.listBySession('NO-SUCH')).toEqual([])
  })

  it('filters by eventType when provided', () => {
    events.create({ sessionId: 'S1', eventType: 'tool_call' })
    events.create({ sessionId: 'S1', eventType: 'decision' })
    events.create({ sessionId: 'S1', eventType: 'tool_call' })
    const toolCalls = events.listBySession('S1', 'tool_call')
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls.every((e) => e.eventType === 'tool_call')).toBe(true)
  })

  it('does not leak events across sessions', () => {
    sessions.create({ id: 'S2', projectId: 'p1' })
    events.create({ sessionId: 'S1', eventType: 'decision' })
    events.create({ sessionId: 'S2', eventType: 'observation' })
    expect(events.listBySession('S1')).toHaveLength(1)
    expect(events.listBySession('S2')).toHaveLength(1)
  })
})
