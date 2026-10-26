// TASK-2759 — the redaction and read-only guarantees, moved with the code from
// companion/assistant-tools.test.ts (TASK-2734, TASK-2743) when the adapter's
// copy was deleted. Nothing here needs an adapter: the read surface is a stub.

import { describe, it, expect, vi } from 'vitest'
import { cap, redact } from './redact'
import { createAssistantTools, type AssistantReadServices } from './tools'

describe('redact', () => {
  it('turns `host 10.20.30.40 ok` into `host [ip] ok`', () => {
    expect(redact('host 10.20.30.40 ok')).toBe('host [ip] ok')
  })

  it('turns a line `password: x` into `[line redacted]` and leaves the next line unchanged', () => {
    expect(redact('password: x\nnext line 1.2')).toBe('[line redacted]\nnext line 1.2')
  })
})

describe('cap', () => {
  it('cuts a 20000-character string to 16000 characters plus `\\n[truncated]`', () => {
    expect(cap('a'.repeat(20000))).toBe('a'.repeat(16000) + '\n[truncated]')
  })

  it('returns a 15999-character string unchanged', () => {
    const s = 'b'.repeat(15999)
    expect(cap(s)).toBe(s)
  })
})

describe('redaction masks string values, not the whole JSON result (TASK-2743)', () => {
  const body = ['## Context', 'uses x-choda-bridge-token', 'plain line'].join('\n')
  const stub = (over: Partial<AssistantReadServices>): AssistantReadServices =>
    ({ getTask: async () => ({ id: 'TASK-9', status: 'IMPLEMENTED', body }), ...over }) as unknown as AssistantReadServices

  it('keeps the status field of a task whose body names a secret', async () => {
    const out = JSON.parse(await createAssistantTools(stub({})).execute('get_task', '{"id":"TASK-9"}')) as { status: string }
    expect(out.status).toBe('IMPLEMENTED')
  })

  it('redacts only the offending body line and leaves the others unchanged', async () => {
    const out = JSON.parse(await createAssistantTools(stub({})).execute('get_task', '{"id":"TASK-9"}')) as { body: string }
    expect(out.body.split('\n')).toEqual(['## Context', '[line redacted]', 'plain line'])
  })

  it('keeps line-level redaction on a plain string result (a vault note)', async () => {
    const t = createAssistantTools(stub({ readVaultNote: async () => 'intro\npassword: x\noutro' }))
    expect(await t.execute('read_vault_note', '{"path":"30-Knowledge/a.md"}')).toBe('intro\n[line redacted]\noutro')
  })
})

describe('read-only', () => {
  it('executing every tool once leaves every create/update/delete spy at zero calls', async () => {
    // Every read method answers; anything else a tool might reach for is a spy.
    const reads = new Set([
      'search',
      'getTask',
      'listTasks',
      'searchKnowledge',
      'getKnowledge',
      'listInbox',
      'getConversation',
      'findMeetings',
      'getMeeting',
      'getRuns',
      'getDailyReport',
      'searchVault',
      'readVaultNote',
      'searchChats',
      'getChat'
    ])
    const writes = new Map<string, ReturnType<typeof vi.fn>>()
    const svc = new Proxy({} as Record<string, unknown>, {
      get(_t, prop: string) {
        if (reads.has(prop)) return async () => (prop === 'readVaultNote' ? 'note' : [])
        let spy = writes.get(prop)
        if (!spy) {
          spy = vi.fn()
          writes.set(prop, spy)
        }
        return spy
      }
    }) as unknown as AssistantReadServices
    const tools = createAssistantTools(svc)
    const args: Record<string, string> = {
      search: '{"query":"x"}',
      get_task: '{"id":"TASK-1"}',
      search_knowledge: '{"query":"x"}',
      get_knowledge: '{"slug":"s"}',
      get_conversation: '{"id":"CONV-1"}',
      get_meeting: '{"id":"m1"}',
      search_vault: '{"query":"x"}',
      read_vault_note: '{"path":"30-Knowledge/a.md"}',
      search_chats: '{"query":"x"}',
      get_chat: '{"id":"CHAT-1"}'
    }
    for (const d of tools.definitions) await tools.execute(d.function.name, args[d.function.name] ?? '{}')
    for (const [name, spy] of writes) expect(spy, name).toHaveBeenCalledTimes(0)
  })
})
