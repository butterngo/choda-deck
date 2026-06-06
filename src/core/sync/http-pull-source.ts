// ADR-030 Phase 2 (TASK-978) — local pull client. A PullSource that fetches the
// remote MCP server's GET /sync/since endpoint over HTTP and hands the deltas to
// the reconcile core (sync-pull.ts). Read-only: it never writes to the remote.

import type { PullSource, TableDelta } from './sync-pull'

export interface HttpPullSourceOptions {
  // Remote MCP origin, e.g. https://mcp.choda.dev or http://localhost:7337.
  remoteUrl: string
  // Bearer token (static MCP_HTTP_TOKEN, or a Keycloak access token in OAuth mode).
  token: string
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
}

export class HttpPullSource implements PullSource {
  private readonly base: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpPullSourceOptions) {
    this.base = opts.remoteUrl.replace(/\/$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async fetchSince(since: number): Promise<TableDelta[]> {
    const url = `${this.base}/sync/since?since=${encodeURIComponent(String(since))}`
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' }
    })
    if (!res.ok) {
      throw new Error(`sync pull: GET /sync/since -> HTTP ${res.status}`)
    }
    const body = (await res.json()) as { deltas?: TableDelta[] }
    return body.deltas ?? []
  }
}
