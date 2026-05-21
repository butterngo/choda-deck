import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startHttpTransport, type HttpTransportHandle } from '../http-transport'
import { createInstrumentedServer } from '../instrumented-server'
import { REMOTE_TOOL_ALLOWLIST } from '../server-bootstrap'

const TOKEN = 'test-token-xyz'
const WRONG_TOKEN = 'test-token-abc'

function buildServerFactory(): () => McpServer {
  return (): McpServer => {
    const server = new McpServer(
      { name: 'test-mcp', version: '0.0.0' },
      { capabilities: { tools: {} } }
    )
    server.registerTool(
      'echo',
      { description: 'echo', inputSchema: {} },
      (async () => ({ content: [{ type: 'text', text: 'ok' }] })) as never
    )
    server.registerTool(
      'ping',
      { description: 'ping', inputSchema: {} },
      (async () => ({ content: [{ type: 'text', text: 'pong' }] })) as never
    )
    return server
  }
}

async function jsonRpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(body)
  })
}

describe('startHttpTransport', () => {
  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    handle = await startHttpTransport(buildServerFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN
    })
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  it('GET /healthz → 200 with {"ok":true}, no auth required', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('POST /mcp without Authorization → 401, empty body', async () => {
    const res = await jsonRpc(baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  it('POST /mcp with wrong bearer → 401, empty body', async () => {
    const res = await jsonRpc(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${WRONG_TOKEN}` }
    )
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('')
  })

  it('POST /mcp with wrong-length bearer → 401 (no timing-leak path)', async () => {
    const res = await jsonRpc(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: 'Bearer short' }
    )
    expect(res.status).toBe(401)
  })

  it('POST /mcp with non-JSON content-type → 415', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        authorization: `Bearer ${TOKEN}`
      },
      body: 'not json'
    })
    expect(res.status).toBe(415)
  })

  it('POST /mcp with body >4 MB → 413', async () => {
    const oversize = 'x'.repeat(4 * 1024 * 1024 + 100)
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`
      },
      body: oversize
    })
    expect(res.status).toBe(413)
  })

  it('POST /mcp with malformed JSON → 400', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${TOKEN}`
      },
      body: '{not-json'
    })
    expect(res.status).toBe(400)
  })

  it('POST /mcp initialize returns 200 (server lifecycle handshake)', async () => {
    const res = await jsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '0.0.0' }
        }
      },
      { authorization: `Bearer ${TOKEN}` }
    )
    expect(res.status).toBe(200)
  })

  it('POST /mcp tools/list returns registered tools', async () => {
    // Stateless mode: each request stands alone. Declare protocol version
    // via header so the SDK accepts a non-init request without prior session.
    const res = await jsonRpc(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      {
        authorization: `Bearer ${TOKEN}`,
        'mcp-protocol-version': '2025-06-18'
      }
    )
    if (res.status !== 200) {
      const debug = await res.text()
      throw new Error(`tools/list returned ${res.status}: ${debug}`)
    }
    const payload = (await res.json()) as { result?: { tools?: { name: string }[] } }
    const names = (payload.result?.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual(['echo', 'ping'])
  })

  it('unknown route → 404', async () => {
    const res = await fetch(`${baseUrl}/nope`)
    expect(res.status).toBe(404)
  })
})

describe('startHttpTransport — concurrent requests', () => {
  it('handles parallel /healthz hits without crashing', async () => {
    const handle = await startHttpTransport(buildServerFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN
    })
    const baseUrl = `http://127.0.0.1:${handle.address.port}`
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => fetch(`${baseUrl}/healthz`).then((r) => r.status))
      )
      expect(results.every((s) => s === 200)).toBe(true)
    } finally {
      await handle.close()
    }
  })
})

describe('startHttpTransport — remote tool allowlist (TASK-903)', () => {
  // Mirror the production wiring: instrumented-server gates registration,
  // bootstrap passes REMOTE_TOOL_ALLOWLIST in http mode. Here we exercise
  // the same code path end-to-end through real Streamable HTTP transport.
  function buildAllowlistFactory(): () => McpServer {
    return (): McpServer => {
      const server = new McpServer(
        { name: 'test-mcp', version: '0.0.0' },
        { capabilities: { tools: {} } }
      )
      const sink = { recordToolInvocation: (): void => {}, countToolInvocations: (): number => 0 }
      const instrumented = createInstrumentedServer(server, sink, REMOTE_TOOL_ALLOWLIST)
      // Register a mix: allowlisted + blocked names. Blocked names must be
      // absent from the resulting tools/list response.
      for (const name of [...REMOTE_TOOL_ALLOWLIST, 'task_create', 'memory_write']) {
        instrumented.registerTool(
          name,
          { description: name, inputSchema: {} },
          (async () => ({ content: [{ type: 'text', text: name }] })) as never
        )
      }
      return server
    }
  }

  let handle: HttpTransportHandle
  let baseUrl: string

  beforeAll(async () => {
    handle = await startHttpTransport(buildAllowlistFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN
    })
    baseUrl = `http://127.0.0.1:${handle.address.port}`
  })

  afterAll(async () => {
    await handle.close()
  })

  it('tools/list returns exactly the allowlisted tool names', async () => {
    const res = await jsonRpc(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-06-18' }
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { result?: { tools?: { name: string }[] } }
    const names = (payload.result?.tools ?? []).map((t) => t.name).sort()
    expect(names).toEqual([...REMOTE_TOOL_ALLOWLIST].sort())
  })

  it('calling a non-allowlisted tool over HTTP returns method-not-found error', async () => {
    const res = await jsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'task_create', arguments: {} }
      },
      { authorization: `Bearer ${TOKEN}`, 'mcp-protocol-version': '2025-06-18' }
    )
    expect(res.status).toBe(200)
    const payload = (await res.json()) as {
      result?: { isError?: boolean; content?: { type: string; text: string }[] }
      error?: { code: number; message: string }
    }
    // SDK reports unknown tools as a successful JSON-RPC response with
    // result.isError=true (rather than a top-level JSON-RPC error). Either
    // shape proves the tool wasn't reachable — assert one of them.
    const reportedAsResultError = payload.result?.isError === true
    const reportedAsRpcError = typeof payload.error?.code === 'number'
    expect(reportedAsResultError || reportedAsRpcError).toBe(true)
  })
})

describe('startHttpTransport — stderr log', () => {
  it('logs listen address to stderr on bind', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const handle = await startHttpTransport(buildServerFactory(), {
      port: 0,
      bind: '127.0.0.1',
      token: TOKEN
    })
    try {
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/MCP HTTP listening on 127\.0\.0\.1:\d+/)
      )
    } finally {
      await handle.close()
      stderrSpy.mockRestore()
    }
  })
})
