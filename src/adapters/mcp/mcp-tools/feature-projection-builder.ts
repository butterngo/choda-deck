import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type { CodeRefOperations } from '../../../core/domain/interfaces/code-ref-operations.interface'
import { splitLines } from '../../../core/utils/lines'
import {
  projectFeature,
  type CodeRefPointer,
  type FeatureProjectionBundle,
  type FeatureProjectionInput,
  type GotchaSummary,
  type ProjectionRole
} from '../../../core/domain/services/feature-projection'

// ADR-NNN Pillar 5 (TASK-994). I/O layer: gather the feature's graph slice once
// from the three first-class repos, then hand it to the pure projectFeature().
// Mirrors project-context-builder.ts (builder composes a typed bundle from
// repos; thin MCP tool wraps it).
export type FeatureProjectionDeps = KnowledgeOperations &
  RelationshipOperations &
  CodeRefOperations

export class FeatureNotFoundError extends Error {
  constructor(featureId: string) {
    super(`Feature ${featureId} not found or not a feature node`)
    this.name = 'FeatureNotFoundError'
  }
}

// Parse a knowledge body into `## heading` → text. Level-2 headings are section
// boundaries; deeper headings stay inside the section body. CRLF-safe.
export function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {}
  let current: string | null = null
  let buffer: string[] = []
  const flush = (): void => {
    if (current) sections[current] = buffer.join('\n').trim()
  }
  for (const line of splitLines(body)) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      flush()
      current = heading[1].toLowerCase()
      buffer = []
    } else if (current) {
      buffer.push(line)
    }
  }
  flush()
  return sections
}

async function gatherGotchas(
  svc: FeatureProjectionDeps,
  featureId: string
): Promise<GotchaSummary[]> {
  const aboutEdges = await svc.getRelationshipsTo(featureId, 'ABOUT')
  const gotchas: GotchaSummary[] = []
  for (const edge of aboutEdges) {
    const entry = await svc.getKnowledge(edge.fromId)
    if (!entry) {
      gotchas.push({ slug: edge.fromId, title: edge.fromId })
      continue
    }
    const sections = parseSections(entry.body)
    gotchas.push({
      slug: entry.slug,
      title: entry.frontmatter.title,
      trigger: sections['trigger'],
      resolution: sections['resolution']
    })
  }
  return gotchas
}

async function gatherCodeRefs(
  svc: FeatureProjectionDeps,
  taskIds: string[]
): Promise<{ pointers: CodeRefPointer[]; hasTouches: boolean }> {
  const pointers: CodeRefPointer[] = []
  let hasTouches = false
  for (const taskId of taskIds) {
    const edges = await svc.getTouchesForTask(taskId)
    if (edges.length > 0) hasTouches = true
    for (const edge of edges) {
      const ref = await svc.getCodeRef(edge.codeRefSlug)
      pointers.push({
        taskId,
        slug: edge.codeRefSlug,
        path: ref?.path ?? edge.codeRefSlug,
        symbol: ref?.symbol ?? null,
        relation: edge.relation
      })
    }
  }
  return { pointers, hasTouches }
}

export async function buildFeatureProjection(
  svc: FeatureProjectionDeps,
  featureId: string,
  role: ProjectionRole
): Promise<FeatureProjectionBundle> {
  const entry = await svc.getKnowledge(featureId)
  if (!entry || entry.frontmatter.type !== 'feature') throw new FeatureNotFoundError(featureId)

  const structured = entry.frontmatter.structured ?? {}
  const inEdges = await svc.getRelationshipsFrom(featureId, 'IN')
  const realizesEdges = await svc.getRelationshipsTo(featureId, 'REALIZES')
  const realizesTaskIds = realizesEdges.map((e) => e.fromId)
  const gotchas = await gatherGotchas(svc, featureId)

  // Dev needs the code_ref pointers; CEO never does (and must not — M3). Skip the
  // TOUCHES walk entirely for CEO.
  const dev = role === 'dev' ? await gatherCodeRefs(svc, realizesTaskIds) : null

  const input: FeatureProjectionInput = {
    featureId,
    title: entry.frontmatter.title,
    status: structured.status,
    effortBand: structured.effortBand,
    sections: parseSections(entry.body),
    workspaces: inEdges.map((e) => e.toId),
    realizesTaskIds,
    gotchas,
    codeRefs: dev?.pointers ?? [],
    realizesTasksHaveTouches: dev?.hasTouches ?? false,
    isStale: entry.isStale
  }

  return projectFeature(input, role)
}
