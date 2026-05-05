import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  emitConversationEvent,
  emitConversationEventFanout,
  normalizeEventTimestamp
} from './event-emitter'

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
        timestamp: '2026-04-24T10:00:00.000Z'
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
      timestamp: '2026-04-24T10:00:00.000Z'
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
        timestamp: '2026-04-24T10:00:00.000Z'
      })
      emitConversationEvent('proj-2', {
        type: 'message.question',
        conversationId: 'CONV-B',
        roles: ['QA'],
        messageType: 'question',
        author: 'PM',
        timestamp: '2026-04-24T10:01:00.000Z'
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
          timestamp: '2026-04-24T10:00:00.000Z'
        })
      ).not.toThrow()
    })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[conversation-event-emitter]')
  })

  it('normalizes SQLite datetime format to ISO before writing', () => {
    const dir = path.join(TMP_ROOT, 'run-iso')
    withEventDir(dir, () => {
      emitConversationEvent('proj-iso', {
        type: 'message.question',
        conversationId: 'CONV-ISO',
        roles: ['BE'],
        messageType: 'question',
        author: 'FE',
        timestamp: '2026-05-04 13:07:08'
      })
    })
    const file = path.join(dir, 'proj-iso.jsonl')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').trim())
    expect(parsed.timestamp).toBe('2026-05-04T13:07:08.000Z')
  })
})

describe('emitConversationEventFanout', () => {
  beforeEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
  })

  afterEach(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const baseEvent = {
    type: 'message.question' as const,
    conversationId: 'CONV-FAN',
    roles: ['owner/main', 'target/main'],
    messageType: 'question',
    author: 'owner',
    timestamp: '2026-05-05T10:00:00.000Z'
  }

  function readLines(file: string): string[] {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  }

  it('writes the same JSONL line to owner and each unique target', () => {
    const dir = path.join(TMP_ROOT, 'fan-multi')
    withEventDir(dir, () => {
      emitConversationEventFanout('owner', ['target-a', 'target-b'], baseEvent)
    })
    const ownerLines = readLines(path.join(dir, 'owner.jsonl'))
    const aLines = readLines(path.join(dir, 'target-a.jsonl'))
    const bLines = readLines(path.join(dir, 'target-b.jsonl'))
    expect(ownerLines.length).toBe(1)
    expect(aLines.length).toBe(1)
    expect(bLines.length).toBe(1)
    expect(JSON.parse(ownerLines[0])).toEqual(JSON.parse(aLines[0]))
    expect(JSON.parse(aLines[0])).toEqual(JSON.parse(bLines[0]))
  })

  it('writes only the owner file when targets is empty (legacy behavior)', () => {
    const dir = path.join(TMP_ROOT, 'fan-owner-only')
    withEventDir(dir, () => {
      emitConversationEventFanout('owner', [], baseEvent)
    })
    expect(readLines(path.join(dir, 'owner.jsonl')).length).toBe(1)
    expect(fs.existsSync(path.join(dir, 'target-a.jsonl'))).toBe(false)
  })

  it('does not duplicate the owner file when owner appears in targets', () => {
    const dir = path.join(TMP_ROOT, 'fan-dedupe-owner')
    withEventDir(dir, () => {
      emitConversationEventFanout('owner', ['owner', 'target-a'], baseEvent)
    })
    expect(readLines(path.join(dir, 'owner.jsonl')).length).toBe(1)
    expect(readLines(path.join(dir, 'target-a.jsonl')).length).toBe(1)
  })

  it('dedupes repeated targets', () => {
    const dir = path.join(TMP_ROOT, 'fan-dedupe-target')
    withEventDir(dir, () => {
      emitConversationEventFanout('owner', ['target-a', 'target-a', 'target-a'], baseEvent)
    })
    expect(readLines(path.join(dir, 'owner.jsonl')).length).toBe(1)
    expect(readLines(path.join(dir, 'target-a.jsonl')).length).toBe(1)
  })

  it('continues writing other files when one target write fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dir = path.join(TMP_ROOT, 'fan-partial-fail')
    fs.mkdirSync(dir, { recursive: true })
    // poison target-bad.jsonl with a directory of the same name so appendFileSync fails
    fs.mkdirSync(path.join(dir, 'target-bad.jsonl'), { recursive: true })

    withEventDir(dir, () => {
      emitConversationEventFanout('owner', ['target-bad', 'target-good'], baseEvent)
    })

    expect(readLines(path.join(dir, 'owner.jsonl')).length).toBe(1)
    expect(readLines(path.join(dir, 'target-good.jsonl')).length).toBe(1)
    expect(warn).toHaveBeenCalled()
  })
})

describe('normalizeEventTimestamp', () => {
  it('passes ISO timestamps through unchanged', () => {
    expect(normalizeEventTimestamp('2026-05-04T13:07:33.192Z')).toBe('2026-05-04T13:07:33.192Z')
  })

  it('coerces SQLite datetime() format (UTC, space-separated) to ISO', () => {
    expect(normalizeEventTimestamp('2026-05-04 13:07:08')).toBe('2026-05-04T13:07:08.000Z')
  })
})
