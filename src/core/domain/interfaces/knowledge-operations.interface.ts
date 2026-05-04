import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeSearchResult,
  KnowledgeVerifyResult,
  UpdateKnowledgeInput
} from '../knowledge-types'

export interface KnowledgeOperations {
  createKnowledge(input: CreateKnowledgeInput): KnowledgeEntry
  getKnowledge(slug: string): KnowledgeEntry | null
  listKnowledge(filter?: KnowledgeListFilter): KnowledgeListItem[]
  updateKnowledge(input: UpdateKnowledgeInput): KnowledgeEntry
  verifyKnowledge(slug: string): KnowledgeVerifyResult
  deleteKnowledge(slug: string): { slug: string; deletedFile: boolean }
  searchKnowledge(query: string, k?: number): Promise<KnowledgeSearchResult>
}
