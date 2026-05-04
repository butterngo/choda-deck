import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { emitConversationEvent } from './event-emitter'

const TMP_ROOT = path.join(os.tmpdir(), 'choda-test-event-emitter')

function withEventDir(dir: string, fn: () => void): void {
  const saved = process.env.CHODA_EVENT_DIR
  process.env.CHODA_EVENT_DIR = dir
  try {
    fn()
  } finally {
    if (saved === undefined) delete process.env.CHODA_EVENT_DIR
    else process.env.CHODA_EVENT_DIR = saved
  }
}

describe('emitConversationEvent', () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('creates the event dir if missing and appends a single JSONL line', () => {
    const dir = path.join(TMP_ROOT, 'run1')
    withEventDir(dir, () => {
      emitConversationEvent('proj-1', {
        type: 'message.question',
        conversationId: 'CONV-1',
        roles: ['BE'],
        messageType: 'question',
        author: 'FE',
        timestamp: '2026-04-24 10:00:00'
      })
    })
    const file = path.join(dir, 'proj-1.jsonl')
    expect(fs.existsSync(file)).toBe(true)
    const contents = fs.readFileSync(file, 'utf8')
    expect(contents.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(contents.trim())
    expect(parsed).toEqual({
      type: 'message.question',
      conversationId: 'CONV-1',
      roles: ['BE'],
      messageType: 'question',
      author: 'FE',
      timestamp: '2026-04-24 10:00:00'
    })
  })

  it('appends to an existing file as one line per event', () => {
    const dir = path.join(TMP_ROOT, 'run2')
    withEventDir(dir, () => {
      emitConversationEvent('proj-2', {
        type: 'message.question',
        conversationId: 'CONV-A',
        roles: ['BE'],
        messageType: 'question',
        author: 'FE',
        timestamp: '2026-04-24 10:00:00'
      })
      emitConversationEvent('proj-2', {
        type: 'message.question',
        conversationId: 'CONV-B',
        roles: ['QA'],
        messageType: 'question',
        author: 'PM',
        timestamp: '2026-04-24 10:01:00'
      })
    })
    const file = path.join(dir, 'proj-2.jsonl')
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).conversationId).toBe('CONV-A')
    expect(JSON.parse(lines[1]).conversationId).toBe('CONV-B')
  })

  it('silently swallows I/O errors and logs a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    fs.mkdirSync(TMP_ROOT, { recursive: true })
    const blocker = path.join(TMP_ROOT, 'blocker')
    fs.writeFileSync(blocker, 'file, not dir')
    const poisonedDir = path.join(blocker, 'nested')

    withEventDir(poisonedDir, () => {
      expect(() =>
        emitConversationEvent('proj-3', {
          type: 'message.question',
          conversationId: 'CONV-X',
          roles: ['BE'],
          messageType: 'question',
          author: 'FE',
          timestamp: '2026-04-24 10:00:00'
        })
      ).not.toThrow()
    })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[conversation-event-emitter]')
  })
})
