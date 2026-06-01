export type KnowledgeType =
  | 'spike'
  | 'decision'
  | 'postmortem'
  | 'learning'
  | 'evaluation'
  | 'feature'
  | 'code_ref'
  | 'gotcha'
export type KnowledgeScope = 'project' | 'cross'

export const KNOWLEDGE_TYPES: readonly KnowledgeType[] = [
  'spike',
  'decision',
  'postmortem',
  'learning',
  'evaluation',
  'feature',
  'code_ref',
  'gotcha'
]

export const KNOWLEDGE_SCOPES: readonly KnowledgeScope[] = ['project', 'cross']

export interface KnowledgeRef {
  path: string
  commitSha: string
}

export type EffortBand = 'S' | 'M' | 'L' | 'XL'

export const EFFORT_BANDS: readonly EffortBand[] = ['S', 'M', 'L', 'XL']

export type FeatureStatus = 'planned' | 'in-progress' | 'shipped' | 'blocked'

export const FEATURE_STATUSES: readonly FeatureStatus[] = [
  'planned',
  'in-progress',
  'shipped',
  'blocked'
]

// TASK-988: optional structured frontmatter for the first-class graph types.
// All fields are optional so the 5 original types (spike/decision/…) keep their
// existing two-line frontmatter unchanged. feature uses anchorTaskId /
// realizesTasks / inWorkspaces / effortBand / status; gotcha uses
// affectedFeatureId. The serializer only emits keys that are set.
export interface KnowledgeStructured {
  anchorTaskId?: string
  realizesTasks?: string[]
  inWorkspaces?: string[]
  effortBand?: EffortBand
  status?: FeatureStatus
  affectedFeatureId?: string
}

export interface KnowledgeFrontmatter {
  type: KnowledgeType
  title: string
  projectId: string
  workspaceId?: string
  scope: KnowledgeScope
  refs: KnowledgeRef[]
  createdAt: string
  lastVerifiedAt: string
  structured?: KnowledgeStructured
}

export interface KnowledgeIndexRow {
  slug: string
  projectId: string
  workspaceId: string | null
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
  workspaceId: string | null
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
  workspaceId?: string
  type: KnowledgeType
  scope: KnowledgeScope
  title: string
  body: string
  refs: CreateKnowledgeRefInput[]
  slug?: string
  structured?: KnowledgeStructured
}

export interface RegisterExistingKnowledgeInput {
  filePath: string
  projectId: string
  workspaceId?: string
}

export interface UpdateKnowledgeInput {
  slug: string
  body?: string
  refs?: CreateKnowledgeRefInput[]
}

export interface KnowledgeListFilter {
  projectId?: string
  workspaceId?: string | null
  scope?: KnowledgeScope
  type?: KnowledgeType
}

export interface KnowledgeVerifyResult {
  slug: string
  refs: KnowledgeRefStaleness[]
  isStale: boolean
  lastVerifiedAt: string
}

export interface KnowledgeSearchHit extends KnowledgeListItem {
  distance: number
}

export interface KnowledgeSearchResult {
  enabled: boolean
  reason?: string
  providerId?: string
  results: KnowledgeSearchHit[]
}
