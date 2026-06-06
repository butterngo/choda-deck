import { describe, it, expect } from 'vitest'
import { HttpPullSource } from './http-pull-source'
import type { TableDelta } from './sync-pull'

describe('HttpPullSource', () => {
  it('GETs /sync/since with the bearer token and parses deltas', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = []
    const deltas: TableDelta[] = [{ table: 'inbox_items', rows: [] }]
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization })
      return { ok: true, status: 200, json: async () => ({ since: 5, deltas }) }
    }) as unknown as typeof fetch

    const src = new HttpPullSource({ remoteUrl: 'http://host:7337/', token: 'tok', fetchImpl })
    const out = await src.fetchSince(5)

    expect(out).toEqual(deltas)
    expect(calls[0].url).toBe('http://host:7337/sync/since?since=5')
    expect(calls[0].auth).toBe('Bearer tok')
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch
    const src = new HttpPullSource({ remoteUrl: 'http://host', token: 't', fetchImpl })
    await expect(src.fetchSince(0)).rejects.toThrow(/HTTP 401/)
  })

  it('defaults to an empty delta list when the body omits deltas', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ since: 0 }) })) as unknown as typeof fetch
    const src = new HttpPullSource({ remoteUrl: 'http://host', token: 't', fetchImpl })
    expect(await src.fetchSince(0)).toEqual([])
  })
})
