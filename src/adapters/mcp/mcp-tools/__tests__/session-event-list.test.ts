import { describe, it, expect, vi } from 'vitest'
import * as sessionEventList from '../session-event-list'
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

function makeEvent(id: string, eventType: SessionEvent['eventType'] = 'observation'): SessionEvent {
  return {
    id,
    sessionId: 'SES-1',
    eventType,
    payloadJson: null,
    memoryCandidate: false,
    createdAt: '2026-05-17T00:00:00.000Z'
  }
}

function makeSvc(events: SessionEvent[]): { svc: SessionEventOperations; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    svc: {
      createSessionEvent: vi.fn(() => makeEvent('EVT-0')),
      listSessionEvents: vi.fn((sessionId, eventType, limit) => {
        calls.push({ sessionId, eventType, limit })
        return events
      })
    },
    calls
  }
}

function parseText<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('session-event-list.register', () => {
  it('registers exactly one tool named session_event_list', () => {
    const { server, tools } = makeFakeServer()
    sessionEventList.register(server, makeSvc([]).svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('session_event_list')
  })

  it('returns events from the repo', async () => {
    const events = [makeEvent('EVT-1'), makeEvent('EVT-2')]
    const { server, tools } = makeFakeServer()
    sessionEventList.register(server, makeSvc(events).svc)

    const result = await tools[0].cb({ sessionId: 'SES-1' })
    const parsed = parseText<SessionEvent[]>(result)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].id).toBe('EVT-1')
  })

  it('forwards eventType filter', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc([])
    sessionEventList.register(server, svc)

    await tools[0].cb({ sessionId: 'SES-1', eventType: 'decision' })
    expect((calls[0] as { eventType: string }).eventType).toBe('decision')
  })

  it('forwards limit', async () => {
    const { server, tools } = makeFakeServer()
    const { svc, calls } = makeSvc([])
    sessionEventList.register(server, svc)

    await tools[0].cb({ sessionId: 'SES-1', limit: 5 })
    expect((calls[0] as { limit: number }).limit).toBe(5)
  })
})
