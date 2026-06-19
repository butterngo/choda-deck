// ADR-030 — discriminated union picking which storage backend
// the runtime will use. Both SQLite and Postgres are implemented;
// the factory dispatches on `kind`.

export type BackendConfig =
  | { kind: 'sqlite'; dbPath: string }
  | { kind: 'postgres'; connectionString: string }
  // ADR-030 Phase 3-6 (979d) — local SQLite + write-through to a remote MCP and a
  // drain/pull loop. Laptop-only (stdio); rejected on http by the transport guard.
  // `oauth` (TASK-1108) — when set, the drain/pull loop refreshes Keycloak access
  // tokens via ROPC so it outlives the ~300s token TTL against an OAuth remote.
  // Absent → static `remoteToken` bearer (MCP_HTTP_TOKEN), unchanged.
  | {
      kind: 'sync'
      dbPath: string
      remoteUrl: string
      remoteToken: string
      intervalMs: number
      oauth?: SyncOAuthConfig
    }

// ROPC credentials for the laptop sync client to mint + refresh Keycloak tokens
// (TASK-1108, ADR-030 §Update 2026-06-18 / ADR-034).
export interface SyncOAuthConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  username: string
  password: string
}
