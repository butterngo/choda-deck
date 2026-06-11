// ADR-030 Phase 3 (TASK-1064 / 979b) — local write client. An ApplySink that
// POSTs locally-stamped deltas to the remote MCP server's POST /sync/apply and
// returns the server's per-row verdicts. The write-side mirror of HttpPullSource
// (sync-source's read client). Used by the write-through wrapper (push on each
// mutating tool call) and by the drain loop (replay of pending_ops).

import type { ApplyResult, ApplySink } from './sync-apply'
import type { TableDelta } from './sync-pull'

export interface HttpWriteClientOptions {
  // Remote MCP origin, e.g. https://mcp.choda.dev or http://localhost:7337.
  remoteUrl: string
  // Bearer token (static MCP_HTTP_TOKEN, or a Keycloak access token in OAuth mode).
  token: string
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
}

export class HttpWriteClient implements ApplySink {
  private readonly base: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpWriteClientOptions) {
    this.base = opts.remoteUrl.replace(/\/$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult> {
    const res = await this.fetchImpl(`${this.base}/sync/apply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ origin, deltas })
    })
    if (!res.ok) {
      throw new Error(`sync apply: POST /sync/apply -> HTTP ${res.status}`)
    }
    return (await res.json()) as ApplyResult
  }
}
