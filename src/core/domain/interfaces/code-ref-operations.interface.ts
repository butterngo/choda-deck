import type {
  CodeRefPrefixFilter,
  CodeRefRow,
  TouchesEdge,
  TouchesRelation,
  UpsertCodeRefInput
} from '../code-ref-types'

// TASK-988 (ADR-NNN unified knowledge graph) — first-class code_ref node +
// TOUCHES edge surface. Stdio-only: the PG facade does not implement it (not in
// the remote allowlist's call graph), matching the knowledge layer's scoping.
export interface CodeRefOperations {
  upsertCodeRef(input: UpsertCodeRefInput): Promise<CodeRefRow>
  getCodeRef(slug: string): Promise<CodeRefRow | null>
  listCodeRefsByPrefix(filter: CodeRefPrefixFilter): Promise<CodeRefRow[]>
  deleteCodeRef(slug: string): Promise<void>
  addTouches(taskId: string, codeRefSlug: string, relation: TouchesRelation): Promise<void>
  removeTouches(taskId: string, codeRefSlug: string): Promise<void>
  getTouchesForTask(taskId: string): Promise<TouchesEdge[]>
  getTouchesForCodeRef(codeRefSlug: string): Promise<TouchesEdge[]>
}
