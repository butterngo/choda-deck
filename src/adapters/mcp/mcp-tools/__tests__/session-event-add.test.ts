import { describe, it, expect, vi } from 'vitest'
import * as sessionEventAdd from '../session-event-add'
import type { InstrumentedServer } from '../../instrumented-server'
import type { SessionEventOperations } from '../../../../core/domain/interfaces/session-event-operations.interface'
import type { SessionEvent } from '../../../../core/domain/task-types'

interface CapturedTool {
  name: string
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn((name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
      tools.push({ name, cb })
      return { name } as never
    }) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return []
    }
  }
  return { server, tools }
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: 'EVT-001',
    sessionId: 'SES-1',
    eventType: 'observation',
    payloadJson: null,
    memoryCandidate: false,
    createdAt: '2026-05-17T00:00:00.000Z',
    ...overrides
  }
}

function makeSvc(returned: SessionEvent): { svc: SessionEventOperations; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    svc: {
      createSessionEvent: vi.fn((input) => {
        calls.push(input)
        return returned
      }),
      listSessionEvents: vi.fn(() => [])
    },
    calls
  }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('session-event-add.register', () => {
  it('registers exactly one tool named session_event_add', () => {
    const { server, tools } = makeFakeServer()
    sessionEventAdd.register(server, makeSvc(makeEvent()).svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('session_event_add')
  })

  it('calls createSessionEvent and returns id + createdAt', async () => {
    const { server, tools } = makeFakeServer()
    const event = makeEvent({ id: 'EVT-XYZ', createdAt: '2026-05-17T01:00:00.000Z' })
    const { svc, calls } = makeSvc(event)
    sessionEventAdd.register(server, svc)

    const result = await tools[0].cb({ sessionId: 'SES-1', eventType: 'observation' })
    const parsed = parseText<{ id: string; createdAt: string }>(result)
    expect(parsed.id).toBe('EVT-XYZ')
    expect(calls[0]).toMatchObject({ sessionId: 'SES-1', eventType: 'observation' })
  })

  it('serialises payload to JSON string', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc(makeEvent())
    sessionEventAdd.register(server, svc)

    await tools[0].cb({ sessionId: 'SES-1', eventType: 'tool_call', payload: { tool: 'grep', args: ['foo'] } })
    expect((calls[0] as { payloadJson: string }).payloadJson).toBe('{"tool":"grep","args":["foo"]}')
  })

  it('defaults memoryCandidate to false when omitted', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc(makeEvent())
    sessionEventAdd.register(server, svc)

    await tools[0].cb({ sessionId: 'SES-1', eventType: 'decision' })
    expect((calls[0] as { memoryCandidate: boolean }).memoryCandidate).toBe(false)
  })

  it('forwards memoryCandidate=true when provided', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc(makeEvent({ memoryCandidate: true }))
    sessionEventAdd.register(server, svc)

    await tools[0].cb({ sessionId: 'SES-1', eventType: 'decision', memoryCandidate: true })
    expect((calls[0] as { memoryCandidate: boolean }).memoryCandidate).toBe(true)
  })
})
