// ADR-030 — discriminated union picking which storage backend
// the runtime will use. SQLite is the only implemented kind today;
// Postgres lands with TASK-934 (driver + schema + pool).

export type BackendConfig =
  | { kind: 'sqlite'; dbPath: string }
  | { kind: 'postgres'; connectionString: string }

export class BackendNotImplementedError extends Error {
  constructor(kind: string) {
    super(
      `Backend kind '${kind}' is not implemented yet. ` +
        `SQLite is the only supported backend until TASK-934 lands the Postgres adapter.`
    )
    this.name = 'BackendNotImplementedError'
  }
}
