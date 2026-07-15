// TASK-1331/1332 — routes a validated capture onto the in-process service.
//   text    → inbox_add / task_create / conversation open|reply / knowledge_create
//   image   → screenshot stored under artifacts/, referenced from a local entry
//   network → headers/cookies record (NO response body) into a local entry
//
// Sync boundary (ADR-036): inbox + task ride the CHODA_BACKEND=sync write-through
// loop to the remote automatically. conversation + knowledge are LOCAL-ONLY. image
// and network captures are restricted to conversation|knowledge (TASK-1332) so
// captured secrets (cookies/tokens) can never reach the sync path.

import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { KnowledgeType } from '../../core/domain/knowledge-types'
import {
  CaptureBadRequestError,
  type CaptureDestination,
  type CaptureDispatcher,
  type CaptureRequest,
  type CaptureResult
} from './capture-contract'
import {
  formatNetworkRecord,
  parseNetworkRecord,
  writeHarArtifact,
  writeImageArtifact
} from './capture-artifacts'
import { parseDiscoveryBundle, writeDiscoverySession } from './discovery-artifacts'

const CAPTURE_AUTHOR = 'companion'
const DEFAULT_KNOWLEDGE_TYPE: KnowledgeType = 'learning'

// Fields every capture payload carries for routing, independent of kind.
interface LocalTarget {
  projectId: string
  title?: string
  conversationId?: string
  knowledgeType?: KnowledgeType
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function asObject(payload: unknown, hint: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) {
    throw new CaptureBadRequestError(hint)
  }
  return payload as Record<string, unknown>
}

// Shared routing fields + the required projectId (the browser has no project
// context, so the extension must supply it).
function parseTarget(p: Record<string, unknown>): LocalTarget {
  const projectId = str(p.projectId)
  if (!projectId) throw new CaptureBadRequestError('payload requires a "projectId"')
  return {
    projectId,
    title: str(p.title),
    conversationId: str(p.conversationId),
    knowledgeType: str(p.knowledgeType) as KnowledgeType | undefined
  }
}

function titleFrom(target: LocalTarget, firstLine: string, sourceUrl: string): string {
  if (target.title) return target.title
  const t = firstLine.trim().slice(0, 80)
  return t.length > 0 ? t : `Captured from ${sourceUrl}`
}

function withSource(body: string, sourceUrl: string): string {
  return `${body}\n\nSource: ${sourceUrl}`
}

// image/network must never target the sync-eligible destinations, so their
// secrets can't leak outward. inbox|task → 400.
function guardLocalOnly(kind: string, destination: CaptureDestination): void {
  if (destination === 'inbox' || destination === 'task') {
    throw new CaptureBadRequestError(
      `${kind} captures may only target conversation or knowledge (local-only)`
    )
  }
}

export class CompanionCaptureDispatcher implements CaptureDispatcher {
  constructor(
    private readonly svc: BackendTaskService,
    private readonly artifactsDir: string
  ) {}

  async dispatch(capture: CaptureRequest): Promise<CaptureResult> {
    switch (capture.kind) {
      case 'text':
        return this.dispatchText(capture)
      case 'image':
        return this.dispatchImage(capture)
      case 'network':
        return this.dispatchNetwork(capture)
      case 'network-bundle':
        return this.dispatchNetworkBundle(capture)
      case 'discovery-session':
        return this.dispatchDiscoverySession(capture)
    }
  }

  // A recorded browsing session → ONE local artifact (jsonl timeline + md draft +
  // snapshots) + ONE raw inbox row that carries only a sanitized summary + a
  // relative pointer, never the raw HTML/network bodies (those stay on disk).
  // Deferred classification: it lands in the inbox to be triaged/promoted later
  // (ADR-011), so — inverse to image/network — it may ONLY target inbox.
  private async dispatchDiscoverySession(capture: CaptureRequest): Promise<CaptureResult> {
    if (capture.destination !== 'inbox') {
      throw new CaptureBadRequestError(
        'discovery-session captures may only target the inbox (deferred classification)'
      )
    }
    const bundle = parseDiscoveryBundle(capture.payload)
    const stored = writeDiscoverySession(this.artifactsDir, bundle)
    const summary =
      `Discovery session${bundle.label ? ` — ${bundle.label}` : ''}: ` +
      `${stored.eventCount} steps · ${stored.navCount} pages · ${stored.apiCount} API calls · ` +
      `${stored.snapshotCount} snapshots.\n\n` +
      `Timeline: \`${stored.relDir}/timeline.jsonl\` · draft: \`${stored.relDir}/draft.md\``
    const item = await this.svc.createInbox({
      projectId: bundle.projectId,
      content: withSource(summary, capture.sourceUrl)
    })
    return { id: item.id, destination: 'inbox' }
  }

  private async dispatchText(capture: CaptureRequest): Promise<CaptureResult> {
    const p = asObject(capture.payload, 'text payload must be an object { text, projectId, ... }')
    const text = str(p.text)
    if (!text) throw new CaptureBadRequestError('text payload requires a non-empty "text"')
    const target = parseTarget(p)
    const { destination, sourceUrl } = capture
    const body = withSource(text, sourceUrl)

    if (destination === 'inbox') {
      const item = await this.svc.createInbox({ projectId: target.projectId, content: body })
      return { id: item.id, destination }
    }
    if (destination === 'task') {
      const task = await this.svc.createTask({
        projectId: target.projectId,
        title: titleFrom(target, text.split(/\r?\n/, 1)[0], sourceUrl),
        body: `## Context\n\n${body}\n`
      })
      return { id: task.id, destination }
    }
    return this.persistLocal(destination, target, titleFrom(target, text.split(/\r?\n/, 1)[0], sourceUrl), body)
  }

  private async dispatchImage(capture: CaptureRequest): Promise<CaptureResult> {
    guardLocalOnly('image', capture.destination)
    const p = asObject(capture.payload, 'image payload must be an object { dataUrl, projectId, ... }')
    const target = parseTarget(p)
    const stored = writeImageArtifact(this.artifactsDir, p.dataUrl)
    const title = titleFrom(target, `Screenshot from ${capture.sourceUrl}`, capture.sourceUrl)
    const body = withSource(`![capture](${stored.filePath})\n\n(${stored.bytes} bytes)`, capture.sourceUrl)
    return this.persistLocal(capture.destination, target, title, body)
  }

  private async dispatchNetwork(capture: CaptureRequest): Promise<CaptureResult> {
    guardLocalOnly('network', capture.destination)
    const p = asObject(capture.payload, 'network payload must be an object { record, projectId, ... }')
    const target = parseTarget(p)
    const record = parseNetworkRecord(p.record)
    const title = titleFrom(target, `${record.method} ${record.url}`, capture.sourceUrl)
    const body = withSource(formatNetworkRecord(record), capture.sourceUrl)
    return this.persistLocal(capture.destination, target, title, body)
  }

  // A selection of network records → ONE .har artifact + ONE local entry linking
  // it (TASK-1372). Never a row per record.
  private async dispatchNetworkBundle(capture: CaptureRequest): Promise<CaptureResult> {
    guardLocalOnly('network-bundle', capture.destination)
    const p = asObject(
      capture.payload,
      'network-bundle payload must be an object { entries, projectId, ... }'
    )
    const target = parseTarget(p)
    if (!Array.isArray(p.entries) || p.entries.length === 0) {
      throw new CaptureBadRequestError('network-bundle payload requires a non-empty "entries" array')
    }
    const records = p.entries.map((e) => parseNetworkRecord(e))
    const stored = writeHarArtifact(this.artifactsDir, records)
    const title = titleFrom(
      target,
      `Network bundle (${records.length} requests) from ${capture.sourceUrl}`,
      capture.sourceUrl
    )
    const body = withSource(
      `HAR bundle: [${records.length} requests](${stored.filePath}) (${stored.bytes} bytes)\n\n` +
        records.map((r) => `- ${r.method} ${r.url}${r.status !== undefined ? ` → ${r.status}` : ''}`).join('\n'),
      capture.sourceUrl
    )
    return this.persistLocal(capture.destination, target, title, body)
  }

  // conversation (open or reply) or knowledge — the local-only destinations shared
  // by text/image/network.
  private async persistLocal(
    destination: CaptureDestination,
    target: LocalTarget,
    title: string,
    body: string
  ): Promise<CaptureResult> {
    if (destination === 'conversation') {
      if (target.conversationId) {
        await this.svc.addConversationMessage({
          conversationId: target.conversationId,
          authorName: CAPTURE_AUTHOR,
          content: body
        })
        return { id: target.conversationId, destination }
      }
      const conversation = await this.svc.openConversation({
        projectId: target.projectId,
        title,
        createdBy: CAPTURE_AUTHOR,
        initialMessage: { content: body }
      })
      return { id: conversation.id, destination }
    }
    // knowledge
    const entry = await this.svc.createKnowledge({
      projectId: target.projectId,
      type: target.knowledgeType ?? DEFAULT_KNOWLEDGE_TYPE,
      scope: 'project',
      title,
      body,
      refs: []
    })
    return { id: entry.slug, destination }
  }
}
