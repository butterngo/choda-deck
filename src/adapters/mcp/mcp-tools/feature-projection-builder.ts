import type { KnowledgeOperations } from '../../../core/domain/interfaces/knowledge-operations.interface'
import type { RelationshipOperations } from '../../../core/domain/interfaces/relationship-repository.interface'
import type { CodeRefOperations } from '../../../core/domain/interfaces/code-ref-operations.interface'
import type { TaskOperations } from '../../../core/domain/interfaces/task-repository.interface'
import { splitLines } from '../../../core/utils/lines'
import { findAcItems } from '../../../core/domain/lifecycle/ac-check'
import {
  projectFeature,
  type CodeRefPointer,
  type EffortTaskSignal,
  type FeatureProjectionBundle,
  type FeatureProjectionInput,
  type GotchaSummary,
  type ProjectionRole,
  type RealizedTaskAc
} from '../../../core/domain/services/feature-projection'

// ADR-NNN Pillar 5 (TASK-994, TASK-995). I/O layer: gather the feature's graph
// slice once from the first-class repos, then hand it to the pure
// projectFeature(). Mirrors project-context-builder.ts (builder composes a typed
// bundle from repos; thin MCP tool wraps it). TaskOperations is the tester role's
// AC source (REALIZES → getTask → findAcItems).
export type FeatureProjectionDeps = KnowledgeOperations &
  RelationshipOperations &
  CodeRefOperations &
  TaskOperations

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
      context: sections['context'],
      resolution: sections['resolution']
    })
  }
  return gotchas
}

// Tester role: collate each REALIZES task's acceptance criteria. A missing task
// (dangling edge) is skipped rather than fabricated.
async function gatherRealizesTasks(
  svc: FeatureProjectionDeps,
  taskIds: string[]
): Promise<RealizedTaskAc[]> {
  const tasks: RealizedTaskAc[] = []
  for (const taskId of taskIds) {
    const task = await svc.getTask(taskId)
    if (!task) continue
    tasks.push({
      taskId,
      title: task.title,
      status: task.status,
      acItems: findAcItems(task.body ?? '').map((i) => i.text)
    })
  }
  return tasks
}

// CEO role: collect band-derivation evidence per realized task — label set, AC
// item count, and immediate blocked-by count. No titles/bodies are carried out,
// so the derived reasoning cannot leak symbols or durations. A missing task
// (dangling REALIZES edge) is skipped, never fabricated.
async function gatherEffortSignal(
  svc: FeatureProjectionDeps,
  taskIds: string[]
): Promise<EffortTaskSignal[]> {
  const signal: EffortTaskSignal[] = []
  for (const taskId of taskIds) {
    const task = await svc.getTask(taskId)
    if (!task) continue
    signal.push({
      taskId,
      labels: task.labels,
      acItemCount: findAcItems(task.body ?? '').length,
      blockedByCount: task.blockedBy.length
    })
  }
  return signal
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
  // TOUCHES walk entirely for CEO. Tester needs the realized-task AC instead, so
  // only it pays the getTask walk.
  const dev = role === 'dev' ? await gatherCodeRefs(svc, realizesTaskIds) : null
  const realizesTasks =
    role === 'tester' ? await gatherRealizesTasks(svc, realizesTaskIds) : []
  // CEO derives its effort band from realized-task signal when none is authored.
  const effortSignal =
    role === 'ceo-po' && !structured.effortBand
      ? await gatherEffortSignal(svc, realizesTaskIds)
      : []

  const input: FeatureProjectionInput = {
    featureId,
    title: entry.frontmatter.title,
    status: structured.status,
    effortBand: structured.effortBand,
    sections: parseSections(entry.body),
    workspaces: inEdges.map((e) => e.toId),
    realizesTaskIds,
    effortSignal,
    gotchas,
    codeRefs: dev?.pointers ?? [],
    realizesTasksHaveTouches: dev?.hasTouches ?? false,
    realizesTasks,
    isStale: entry.isStale
  }

  return projectFeature(input, role)
}
