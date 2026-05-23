import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeSearchResult,
  KnowledgeVerifyResult,
  RegisterExistingKnowledgeInput,
  UpdateKnowledgeInput
} from '../knowledge-types'

export interface KnowledgeOperations {
  createKnowledge(input: CreateKnowledgeInput): Promise<KnowledgeEntry>
  registerExistingKnowledge(input: RegisterExistingKnowledgeInput): Promise<KnowledgeEntry>
  getKnowledge(slug: string): Promise<KnowledgeEntry | null>
  listKnowledge(filter?: KnowledgeListFilter): Promise<KnowledgeListItem[]>
  updateKnowledge(input: UpdateKnowledgeInput): Promise<KnowledgeEntry>
  verifyKnowledge(slug: string): Promise<KnowledgeVerifyResult>
  deleteKnowledge(slug: string): Promise<{ slug: string; deletedFile: boolean }>
  searchKnowledge(query: string, k?: number): Promise<KnowledgeSearchResult>
}
