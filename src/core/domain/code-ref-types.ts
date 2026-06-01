export type TouchesRelation = 'modifies' | 'reference'

export const TOUCHES_RELATIONS: readonly TouchesRelation[] = ['modifies', 'reference']

export interface CodeRefRow {
  slug: string
  projectId: string
  workspaceId: string | null
  path: string
  symbol: string | null
  lineHint: number | null
  commitSha: string | null
  createdAt: string
  lastVerifiedAt: string
}

export interface UpsertCodeRefInput {
  slug: string
  projectId: string
  workspaceId?: string | null
  path: string
  symbol?: string | null
  lineHint?: number | null
  commitSha?: string | null
}

export interface CodeRefPrefixFilter {
  projectId: string
  symbolPrefix?: string
  path?: string
}

export interface TouchesEdge {
  taskId: string
  codeRefSlug: string
  relation: TouchesRelation
}
