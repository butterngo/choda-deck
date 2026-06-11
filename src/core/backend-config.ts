// ADR-030 — discriminated union picking which storage backend
// the runtime will use. Both SQLite and Postgres are implemented;
// the factory dispatches on `kind`.

export type BackendConfig =
  | { kind: 'sqlite'; dbPath: string }
  | { kind: 'postgres'; connectionString: string }
  // ADR-030 Phase 3-6 (979d) — local SQLite + write-through to a remote MCP and a
  // drain/pull loop. Laptop-only (stdio); rejected on http by the transport guard.
  | { kind: 'sync'; dbPath: string; remoteUrl: string; remoteToken: string; intervalMs: number }
