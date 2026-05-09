import { describe, it, expect, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createInstrumentedServer } from '../instrumented-server'
import type {
  ToolInvocation,
  ToolInvocationOperations
} from '../../../core/domain/interfaces/tool-invocations-repository.interface'

interface CapturedTool {
  name: string
  cb: (...args: unknown[]) => unknown
}

function makeFakeServer(): { server: McpServer; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, cb: (...args: unknown[]) => unknown) => {
      tools.push({ name, cb })
      return { name } as unknown
    })
  } as unknown as McpServer
  return { server, tools }
}

function makeFakeSink(): { sink: ToolInvocationOperations; rows: ToolInvocation[] } {
  const rows: ToolInvocation[] = []
  return {
    sink: {
      recordToolInvocation: (row): void => {
        rows.push(row)
      },
      countToolInvocations: (): number => rows.length
    },
    rows
  }
}

describe('createInstrumentedServer', () => {
  it('records sync ok call: returns value, ok=true, errorKind=null', async () => {
    const { server, tools } = makeFakeServer()
    const { sink, rows } = makeFakeSink()
    const instrumented = createInstrumentedServer(server, sink)

    instrumented.registerTool(
      'sync_ok',
      { description: 'd', inputSchema: {} },
      (() => ({ content: [{ type: 'text', text: 'sync-result' }] })) as never
    )

    const result = await tools[0].cb({})
    expect(result).toEqual({ content: [{ type: 'text', text: 'sync-result' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].toolName).toBe('sync_ok')
    expect(rows[0].ok).toBe(true)
    expect(rows[0].errorKind).toBeNull()
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(rows[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records async ok call: awaits Promise, ok=true', async () => {
    const { server, tools } = makeFakeServer()
    const { sink, rows } = makeFakeSink()
    const instrumented = createInstrumentedServer(server, sink)

    instrumented.registerTool(
      'async_ok',
      { description: 'd', inputSchema: {} },
      (async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { content: [{ type: 'text', text: 'async-result' }] }
      }) as never
    )

    const result = await tools[0].cb({})
    expect(result).toEqual({ content: [{ type: 'text', text: 'async-result' }] })
    expect(rows).toHaveLength(1)
    expect(rows[0].toolName).toBe('async_ok')
    expect(rows[0].ok).toBe(true)
    expect(rows[0].errorKind).toBeNull()
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(5)
  })

  it('records sync throw: error propagates, ok=false, errorKind=name', async () => {
    const { server, tools } = makeFakeServer()
    const { sink, rows } = makeFakeSink()
    const instrumented = createInstrumentedServer(server, sink)

    class CustomBoom extends Error {
      override readonly name = 'CustomBoom'
    }
    instrumented.registerTool(
      'sync_throw',
      { description: 'd', inputSchema: {} },
      (() => {
        throw new CustomBoom('sensitive payload /home/user/secret')
      }) as never
    )

    await expect(tools[0].cb({})).rejects.toThrow(CustomBoom)
    expect(rows).toHaveLength(1)
    expect(rows[0].toolName).toBe('sync_throw')
    expect(rows[0].ok).toBe(false)
    expect(rows[0].errorKind).toBe('CustomBoom')
    // Confirm the error message (with sensitive payload) is NOT recorded.
    expect(JSON.stringify(rows[0])).not.toContain('sensitive payload')
  })

  it('records async reject: rejection propagates, ok=false, errorKind=name', async () => {
    const { server, tools } = makeFakeServer()
    const { sink, rows } = makeFakeSink()
    const instrumented = createInstrumentedServer(server, sink)

    instrumented.registerTool(
      'async_reject',
      { description: 'd', inputSchema: {} },
      (async () => {
        await new Promise((r) => setTimeout(r, 1))
        const err = new TypeError('boom')
        throw err
      }) as never
    )

    await expect(tools[0].cb({})).rejects.toThrow(TypeError)
    expect(rows).toHaveLength(1)
    expect(rows[0].toolName).toBe('async_reject')
    expect(rows[0].ok).toBe(false)
    expect(rows[0].errorKind).toBe('TypeError')
  })

  it('swallows insert errors — tool call still succeeds when sink throws', async () => {
    const { server, tools } = makeFakeServer()
    const failingSink: ToolInvocationOperations = {
      recordToolInvocation: () => {
        throw new Error('disk full')
      },
      countToolInvocations: () => 0
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const instrumented = createInstrumentedServer(server, failingSink)

    instrumented.registerTool(
      'sink_fail',
      { description: 'd', inputSchema: {} },
      (() => 'still-works') as never
    )

    const result = await tools[0].cb({})
    expect(result).toBe('still-works')
    expect(warnSpy).toHaveBeenCalledWith(
      '[choda-deck] tool invocation insert failed',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('exposes registeredToolNames as canonical universe', () => {
    const { server } = makeFakeServer()
    const { sink } = makeFakeSink()
    const instrumented = createInstrumentedServer(server, sink)

    instrumented.registerTool('a', { description: 'd', inputSchema: {} }, (() => 'x') as never)
    instrumented.registerTool('b', { description: 'd', inputSchema: {} }, (() => 'y') as never)

    expect(instrumented.registeredToolNames).toEqual(['a', 'b'])
  })
})
