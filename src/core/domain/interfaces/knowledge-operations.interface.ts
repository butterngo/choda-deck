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
  createKnowledge(input: CreateKnowledgeInput): KnowledgeEntry
  registerExistingKnowledge(input: RegisterExistingKnowledgeInput): KnowledgeEntry
  getKnowledge(slug: string): KnowledgeEntry | null
  listKnowledge(filter?: KnowledgeListFilter): KnowledgeListItem[]
  updateKnowledge(input: UpdateKnowledgeInput): KnowledgeEntry
  verifyKnowledge(slug: string): KnowledgeVerifyResult
  deleteKnowledge(slug: string): { slug: string; deletedFile: boolean }
  searchKnowledge(query: string, k?: number): Promise<KnowledgeSearchResult>
}
