export type KnowledgeType = 'spike' | 'decision' | 'postmortem' | 'learning' | 'evaluation'
export type KnowledgeScope = 'project' | 'cross'

export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = [
  'spike',
  'decision',
  'postmortem',
  'learning',
  'evaluation'
]

export const KNOWLEDGE_SCOPES: readonly KnowledgeScope[] = ['project', 'cross']

export interface KnowledgeRef {
  path: string
  commitSha: string
}

export interface KnowledgeFrontmatter {
  type: KnowledgeType
  title: string
  projectId: string
  scope: KnowledgeScope
  refs: KnowledgeRef[]
  createdAt: string
  lastVerifiedAt: string
}

export interface KnowledgeIndexRow {
  slug: string
  projectId: string
  scope: KnowledgeScope
  type: KnowledgeType
  title: string
  filePath: string
  createdAt: string
  lastVerifiedAt: string
}

export interface KnowledgeRefStaleness {
  path: string
  commitSha: string
  commitsSince: number
}

export interface KnowledgeEntry {
  slug: string
  frontmatter: KnowledgeFrontmatter
  body: string
  filePath: string
  staleness: KnowledgeRefStaleness[]
  isStale: boolean
}

export interface KnowledgeListItem {
  slug: string
  projectId: string
  scope: KnowledgeScope
  type: KnowledgeType
  title: string
  filePath: string
  createdAt: string
  lastVerifiedAt: string
}

export interface CreateKnowledgeRefInput {
  path: string
  commitSha?: string
}

export interface CreateKnowledgeInput {
  projectId: string
  type: KnowledgeType
  scope: KnowledgeScope
  title: string
  body: string
  refs: CreateKnowledgeRefInput[]
  slug?: string
}

export interface KnowledgeListFilter {
  projectId?: string
  scope?: KnowledgeScope
  type?: KnowledgeType
}

export interface KnowledgeVerifyResult {
  slug: string
  refs: KnowledgeRefStaleness[]
  isStale: boolean
  lastVerifiedAt: string
}
