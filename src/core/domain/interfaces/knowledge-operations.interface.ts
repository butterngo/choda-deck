import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeSearchResult,
  KnowledgeSource,
  KnowledgeVerifyResult,
  RegisterExistingKnowledgeInput,
  UpdateKnowledgeInput
} from '../knowledge-types'

export interface KnowledgeOperations {
  createKnowledge(input: CreateKnowledgeInput): Promise<KnowledgeEntry>
  registerExistingKnowledge(input: RegisterExistingKnowledgeInput): Promise<KnowledgeEntry>
  getKnowledge(slug: string): Promise<KnowledgeEntry | null>
  /**
   * TASK-1785 — frontmatter and body ONLY, with no staleness computed.
   *
   * `getKnowledge` runs a `git log` subprocess per ref to answer "has this
   * drifted", which is the right thing for a reader that asked. It is the wrong
   * thing for a caller that only wants the text: task provenance scans every
   * decision entry's body for a task mention, and paying for staleness it never
   * reads took GET /tasks/:id to ~15 seconds.
   *
   * The return type deliberately omits `staleness` and `isStale` rather than
   * returning empty ones. A `staleness: []` would read as "nothing has drifted",
   * which is a claim this path is not entitled to make.
   */
  readKnowledgeSource(slug: string): Promise<KnowledgeSource | null>
  listKnowledge(filter?: KnowledgeListFilter): Promise<KnowledgeListItem[]>
  updateKnowledge(input: UpdateKnowledgeInput): Promise<KnowledgeEntry>
  verifyKnowledge(slug: string): Promise<KnowledgeVerifyResult>
  deleteKnowledge(slug: string): Promise<{ slug: string; deletedFile: boolean }>
  searchKnowledge(query: string, k?: number): Promise<KnowledgeSearchResult>
}
