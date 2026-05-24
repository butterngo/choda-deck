// ADR-030 — discriminated union picking which storage backend
// the runtime will use. Both SQLite and Postgres are implemented;
// the factory dispatches on `kind`.

export type BackendConfig =
  | { kind: 'sqlite'; dbPath: string }
  | { kind: 'postgres'; connectionString: string }
