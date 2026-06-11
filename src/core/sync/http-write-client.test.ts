// ADR-030 Phase 3 (979b) — HttpWriteClient unit tests with an injected fetch.

import { describe, it, expect } from 'vitest'
import { HttpWriteClient } from './http-write-client'
import type { TableDelta } from './sync-pull'

const deltas: TableDelta[] = [
  { table: 'inbox_items', rows: [{ id: 'INBOX-1', sync_updated_at: 1, sync_deleted_at: null }] }
]

describe('HttpWriteClient', () => {
  it('POSTs { origin, deltas } to /sync/apply with bearer and returns the verdicts', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ applied: 1, tombstoned: 0, conflicts: 0, verdicts: [] }), {
        status: 200
      })
    }) as unknown as typeof fetch

    const client = new HttpWriteClient({ remoteUrl: 'http://h:7337/', token: 'tok', fetchImpl: fakeFetch })
    const res = await client.applyDelta(deltas, 'laptop')

    expect(res).toMatchObject({ applied: 1 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://h:7337/sync/apply') // trailing slash trimmed
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ origin: 'laptop', deltas })
  })

  it('throws on a non-2xx response (so the caller enqueues)', async () => {
    const fakeFetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    const client = new HttpWriteClient({ remoteUrl: 'http://h', token: 't', fetchImpl: fakeFetch })
    await expect(client.applyDelta(deltas, 'laptop')).rejects.toThrow(/HTTP 503/)
  })
})
