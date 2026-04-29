import type {
  CreateKnowledgeInput,
  KnowledgeEntry,
  KnowledgeListFilter,
  KnowledgeListItem,
  KnowledgeVerifyResult
} from '../knowledge-types'

export interface KnowledgeOperations {
  createKnowledge(input: CreateKnowledgeInput): KnowledgeEntry
  getKnowledge(slug: string): KnowledgeEntry | null
  listKnowledge(filter?: KnowledgeListFilter): KnowledgeListItem[]
  verifyKnowledge(slug: string): KnowledgeVerifyResult
}
