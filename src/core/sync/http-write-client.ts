// ADR-030 Phase 3 (TASK-1064 / 979b) — local write client. An ApplySink that
// POSTs locally-stamped deltas to the remote MCP server's POST /sync/apply and
// returns the server's per-row verdicts. The write-side mirror of HttpPullSource
// (sync-source's read client). Used by the write-through wrapper (push on each
// mutating tool call) and by the drain loop (replay of pending_ops).

import type { ApplyResult, ApplySink } from './sync-apply'
import type { TableDelta } from './sync-pull'
import { resolveTokens, type TokenProvider } from './keycloak-token-provider'

// Carries the HTTP status so the drain can tell a PERMANENT per-op rejection
// (4xx — remote will never accept this op; skip it) from a TRANSIENT outage
// (5xx / network — retry later). `status` is 0 for a non-HTTP failure.
export class SyncApplyError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'SyncApplyError'
  }
}

export interface HttpWriteClientOptions {
  // Remote MCP origin, e.g. https://mcp.choda.dev or http://localhost:7337.
  remoteUrl: string
  // Static bearer (MCP_HTTP_TOKEN). Mutually exclusive with getToken.
  token?: string
  // Per-request token provider (Keycloak refresh flow, TASK-1108). Wins over token.
  getToken?: () => Promise<string>
  // Injectable for tests; defaults to global fetch.
  fetchImpl?: typeof fetch
}

export class HttpWriteClient implements ApplySink {
  private readonly base: string
  private readonly tokens: TokenProvider
  private readonly fetchImpl: typeof fetch

  constructor(opts: HttpWriteClientOptions) {
    this.base = opts.remoteUrl.replace(/\/$/, '')
    this.tokens = resolveTokens(opts.getToken, opts.token)
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async applyDelta(deltas: TableDelta[], origin: string): Promise<ApplyResult> {
    const res = await this.fetchImpl(`${this.base}/sync/apply`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.tokens.getToken()}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ origin, deltas })
    })
    if (!res.ok) {
      // Surface the response body — a bare status hides the contract violation
      // (which table/row/field the remote rejected), making a failed push
      // undiagnosable. Body is best-effort; never let reading it mask the status.
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 500)
      } catch {
        /* ignore — keep the status */
      }
      throw new SyncApplyError(
        `sync apply: POST /sync/apply -> HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
        res.status
      )
    }
    return (await res.json()) as ApplyResult
  }
}

// Connectivity gate for the drain loop (ADR-030 §Reconnect drain). GET /healthz
// is unauthenticated and returns {"ok":true}; any non-2xx or network error means
// "treat the remote as down, skip this drain cycle". Never throws.
export async function isRemoteReachable(
  remoteUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const base = remoteUrl.replace(/\/$/, '')
  try {
    const res = await fetchImpl(`${base}/healthz`, { method: 'GET' })
    return res.ok
  } catch {
    return false
  }
}
