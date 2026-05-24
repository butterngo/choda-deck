// ADR-030 slice 11/N — Postgres mode V1 ships the 16 repository-level
// operations but does not yet port the composite-transaction lifecycle
// services (inbox / conversation / session / task-review) or the
// knowledge layer. Calling those operations on PostgresTaskService
// throws this error so misuse is loud, not silent.
//
// Future slices will swap each throw for a real implementation:
// see ADR-030 §rollout for the sequence.

export class PostgresNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `Operation '${operation}' is not yet implemented for the Postgres backend. ` +
        `Slice 11/N of TASK-934 ships repo-level operations only; lifecycle, ` +
        `knowledge, backup, and checkAcItem land in follow-up slices. Use the ` +
        `SQLite backend if you need this operation today.`
    )
    this.name = 'PostgresNotImplementedError'
  }
}
