import { describe, it, expect, vi } from 'vitest'
import * as statsTools from '../stats-tools'
import type { InstrumentedServer } from '../../instrumented-server'
import type {
  ToolInvocationAggregate,
  ToolInvocationOperations,
  ToolInvocationWindow
} from '../../../../core/domain/interfaces/tool-invocations-repository.interface'
import type { StatsReport } from '../../../../core/domain/stats-service'

interface CapturedTool {
  name: string
  cb: (args: unknown) => Promise<unknown>
}

function makeFakeServer(canonical: string[]): { server: InstrumentedServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server: InstrumentedServer = {
    registerTool: vi.fn((name: string, _config: unknown, cb: (args: unknown) => Promise<unknown>) => {
      tools.push({ name, cb })
      return { name } as never
    }) as unknown as InstrumentedServer['registerTool'],
    get registeredToolNames(): ReadonlyArray<string> {
      return canonical
    }
  }
  return { server, tools }
}

function fakeSvc(rows: ToolInvocationAggregate[]): {
  svc: ToolInvocationOperations
  windows: ToolInvocationWindow[]
} {
  const windows: ToolInvocationWindow[] = []
  return {
    svc: {
      recordToolInvocation: () => {},
      countToolInvocations: () => 0,
      queryToolInvocations: (window): ToolInvocationAggregate[] => {
        windows.push(window)
        return rows
      }
    },
    windows
  }
}

function parseTextResponse<T>(result: unknown): T {
  const r = result as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text) as T
}

describe('stats-tools.register', () => {
  it('registers exactly one tool named stats_report', () => {
    const { server, tools } = makeFakeServer([])
    const { svc } = fakeSvc([])
    statsTools.register(server, svc)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('stats_report')
  })

  it('forwards since/until to query and echoes them in period', async () => {
    const { server, tools } = makeFakeServer([])
    const { svc, windows } = fakeSvc([])
    statsTools.register(server, svc)

    const result = await tools[0].cb({
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-09T23:59:59Z'
    })
    expect(windows[0]).toEqual({
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-09T23:59:59Z'
    })
    const report = parseTextResponse<StatsReport>(result)
    expect(report.period).toEqual({
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-09T23:59:59Z'
    })
  })

  it('omitted since/until → window with both null', async () => {
    const { server, tools } = makeFakeServer([])
    const { svc, windows } = fakeSvc([])
    statsTools.register(server, svc)

    await tools[0].cb({})
    expect(windows[0]).toEqual({ since: null, until: null })
  })

  it('AC-7: canonical tool with no rows surfaces as dead-in-window', async () => {
    const { server, tools } = makeFakeServer(['called', 'never_called'])
    const { svc } = fakeSvc([
      {
        tool: 'called',
        calls: 3,
        errors: 0,
        avgDurationMs: 5,
        lastUsedAt: '2026-05-09T00:00:00.000Z'
      }
    ])
    statsTools.register(server, svc)

    const result = await tools[0].cb({})
    const report = parseTextResponse<StatsReport>(result)
    expect(report.deadInWindow).toEqual(['never_called'])
    const ghost = report.perTool.find((t) => t.tool === 'never_called')!
    expect(ghost.calls).toBe(0)
    expect(ghost.lastUsedAt).toBeNull()
    expect(ghost.classification).toBe('dead-in-window')
  })

  it('reads canonical universe at call time, not register time', async () => {
    const canonical: string[] = ['a']
    const { server, tools } = makeFakeServer(canonical)
    const { svc } = fakeSvc([])
    statsTools.register(server, svc)
    // Mutate after register, before call — simulates additional tools registered later.
    canonical.push('b')

    const result = await tools[0].cb({})
    const report = parseTextResponse<StatsReport>(result)
    expect(report.perTool.map((t) => t.tool).sort()).toEqual(['a', 'b'])
  })
})
