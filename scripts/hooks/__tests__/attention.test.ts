import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { decide, handleEvent, LONG_TURN_MS } from '../attention.mjs'
import { withAttentionHooks, EVENTS } from '../../install-attention-hooks.mjs'

// TASK-2383 — the attention hook's rules, its files, and the idempotent installer.

const T0 = Date.parse('2026-10-11T05:00:00Z')

describe('decide (AC-1)', () => {
  it('a Stop 150 s after the prompt notifies; after 60 s it does not', () => {
    const stop = { hook_event_name: 'Stop', session_id: 's', cwd: 'C:/dev/x' }
    expect(decide(stop, { startedAt: T0, now: T0 + 150_000 }).notify).toEqual({
      kind: 'finished',
      minutes: 3
    })
    expect(decide(stop, { startedAt: T0, now: T0 + 60_000 }).notify).toBeNull()
    // Exactly at the threshold counts.
    expect(decide(stop, { startedAt: T0, now: T0 + LONG_TURN_MS }).notify).not.toBeNull()
  })

  it('a Notification event notifies regardless of duration', () => {
    const n = {
      hook_event_name: 'Notification',
      session_id: 's',
      message: 'Permission to use Bash'
    }
    expect(decide(n, { startedAt: T0, now: T0 + 1_000 }).notify).toEqual({
      kind: 'waiting',
      detail: 'Permission to use Bash'
    })
    expect(decide(n, { startedAt: null, now: T0 }).state).toBe('waiting')
  })
})

describe('handleEvent files (AC-2)', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const file = (sid: string): string => path.join(dir, 'attention', `${sid}.json`)
  const read = (sid: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(file(sid), 'utf8'))

  it('prompt → stop writes "finished" with the documented shape, and toasts only a long turn', () => {
    const toasts: unknown[] = []
    const toast = (t: unknown): void => void toasts.push(t)
    handleEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'abc', cwd: 'C:/dev/choda-deck' },
      { dataDir: dir, now: T0, toast }
    )
    expect(fs.existsSync(file('abc'))).toBe(false)
    handleEvent(
      { hook_event_name: 'Stop', session_id: 'abc', cwd: 'C:/dev/choda-deck' },
      { dataDir: dir, now: T0 + 180_000, toast }
    )
    expect(read('abc')).toEqual({
      sessionId: 'abc',
      cwd: 'C:/dev/choda-deck',
      state: 'finished',
      since: new Date(T0 + 180_000).toISOString()
    })
    expect(toasts).toEqual([
      { title: 'Claude xong việc — choda-deck', body: 'Lượt chạy 3 phút đã kết thúc.' }
    ])
  })

  it('Notification writes "waiting"; the next prompt removes the file', () => {
    const toast = (): void => {}
    handleEvent(
      {
        hook_event_name: 'Notification',
        session_id: 'abc',
        cwd: 'C:/dev/x',
        message: 'needs input'
      },
      { dataDir: dir, now: T0, toast }
    )
    expect(read('abc').state).toBe('waiting')
    handleEvent(
      { hook_event_name: 'UserPromptSubmit', session_id: 'abc', cwd: 'C:/dev/x' },
      { dataDir: dir, now: T0 + 5_000, toast }
    )
    expect(fs.existsSync(file('abc'))).toBe(false)
  })

  it('ignores a session id that could escape the folder', () => {
    expect(
      handleEvent(
        { hook_event_name: 'Stop', session_id: '../evil' },
        { dataDir: dir, now: T0, toast: () => {} }
      )
    ).toBeNull()
    expect(fs.existsSync(path.join(dir, 'evil.json'))).toBe(false)
  })

  it('the real script exits 0 on garbage stdin and without a data dir', () => {
    const script = path.resolve(__dirname, '..', 'attention.mjs')
    const garbage = spawnSync(process.execPath, [script, '--data-dir', dir], {
      input: '{not json',
      encoding: 'utf8'
    })
    expect(garbage.status).toBe(0)
    const noDir = spawnSync(process.execPath, [script], {
      input: '{}',
      encoding: 'utf8',
      env: { ...process.env, CHODA_DATA_DIR: '' }
    })
    expect(noDir.status).toBe(0)
  })
})

describe('installer (AC-3)', () => {
  const opts = {
    node: 'C:/n/node.exe',
    script: 'C:/dev/choda-deck/scripts/hooks/attention.mjs',
    dataDir: 'C:/dev/choda-deck/data'
  }
  const existing = {
    model: 'opus',
    hooks: {
      PostToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: 'node', args: ['file-edit-event.mjs'] }]
        }
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'other-stop-hook' }] }]
    }
  }

  it('run twice → exactly one attention entry per event, every other hook kept', () => {
    const twice = withAttentionHooks(withAttentionHooks(existing, opts), opts)
    for (const ev of EVENTS) {
      const ours = (twice.hooks[ev] ?? []).filter((g: { hooks: { args?: string[] }[] }) =>
        g.hooks.some((h) => (h.args ?? []).some((a) => a.includes('attention.mjs')))
      )
      expect(ours, ev).toHaveLength(1)
      expect(ours[0].hooks[0].args).toEqual([opts.script, '--data-dir', opts.dataDir])
    }
    expect(twice.hooks.PostToolUse).toEqual(existing.hooks.PostToolUse)
    expect(twice.hooks.Stop).toContainEqual(existing.hooks.Stop[0])
    expect(twice.model).toBe('opus')
  })

  it('uninstall removes only the attention entries', () => {
    const removed = withAttentionHooks(withAttentionHooks(existing, opts), {
      ...opts,
      remove: true
    })
    expect(removed.hooks).toEqual(existing.hooks)
  })
})
