// TASK-1331 — routes a validated `kind:'text'` capture onto the in-process
// service: inbox_add / task_create / conversation open|reply / knowledge_create.
// Each destination is a thin mapping. Image/network kinds are TASK-1332 and 501
// here (UnimplementedKindError).
//
// Sync boundary (ADR-036): inbox + task ride the CHODA_BACKEND=sync write-through
// loop to the remote automatically. conversation + knowledge are LOCAL-ONLY by
// design (conversation_* gated per TASK-1067; knowledge_* not in the write-through
// path). This dispatcher does NOT widen sync scope — it only calls the same
// service methods the MCP tools do.

import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import type { KnowledgeType } from '../../core/domain/knowledge-types'
import {
  CaptureBadRequestError,
  UnimplementedKindError,
  type CaptureDispatcher,
  type CaptureRequest,
  type CaptureResult
} from './capture-contract'

// The author attributed to captures opened/replied as conversation turns.
const CAPTURE_AUTHOR = 'companion'
// page → knowledge defaults to a project-scoped learning entry unless overridden.
const DEFAULT_KNOWLEDGE_TYPE: KnowledgeType = 'learning'

// Parsed text-kind payload. The contract validator guarantees `payload` is
// present; this narrows it to the fields the destinations need.
interface TextPayload {
  text: string
  projectId: string
  title?: string
  conversationId?: string
  knowledgeType?: KnowledgeType
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// Text captures require an object payload carrying at least `text` + `projectId`
// (the browser has no project context, so the extension must supply it).
function parseTextPayload(payload: unknown): TextPayload {
  if (typeof payload !== 'object' || payload === null) {
    throw new CaptureBadRequestError('text payload must be an object { text, projectId, ... }')
  }
  const p = payload as Record<string, unknown>
  const text = str(p.text)
  const projectId = str(p.projectId)
  if (!text) throw new CaptureBadRequestError('text payload requires a non-empty "text"')
  if (!projectId) throw new CaptureBadRequestError('text payload requires a "projectId"')
  return {
    text,
    projectId,
    title: str(p.title),
    conversationId: str(p.conversationId),
    knowledgeType: str(p.knowledgeType) as KnowledgeType | undefined
  }
}

// A short title derived from the captured text when the payload gives none.
function deriveTitle(payload: TextPayload, sourceUrl: string): string {
  if (payload.title) return payload.title
  const firstLine = payload.text.split(/\r?\n/, 1)[0].trim()
  if (firstLine.length > 0) return firstLine.slice(0, 80)
  return `Captured from ${sourceUrl}`
}

function withSource(text: string, sourceUrl: string): string {
  return `${text}\n\nSource: ${sourceUrl}`
}

export class CompanionCaptureDispatcher implements CaptureDispatcher {
  constructor(private readonly svc: BackendTaskService) {}

  async dispatch(capture: CaptureRequest): Promise<CaptureResult> {
    // TASK-1331 handles text only; image/network land in TASK-1332.
    if (capture.kind !== 'text') throw new UnimplementedKindError(capture.kind)
    const payload = parseTextPayload(capture.payload)
    const { destination, sourceUrl } = capture

    switch (destination) {
      case 'inbox': {
        const item = await this.svc.createInbox({
          projectId: payload.projectId,
          content: withSource(payload.text, sourceUrl)
        })
        return { id: item.id, destination }
      }
      case 'task': {
        const task = await this.svc.createTask({
          projectId: payload.projectId,
          title: deriveTitle(payload, sourceUrl),
          body: `## Context\n\n${withSource(payload.text, sourceUrl)}\n`
        })
        return { id: task.id, destination }
      }
      case 'conversation': {
        // Reply when the payload names an existing thread; else open a new one.
        if (payload.conversationId) {
          await this.svc.addConversationMessage({
            conversationId: payload.conversationId,
            authorName: CAPTURE_AUTHOR,
            content: withSource(payload.text, sourceUrl)
          })
          return { id: payload.conversationId, destination }
        }
        const conversation = await this.svc.openConversation({
          projectId: payload.projectId,
          title: deriveTitle(payload, sourceUrl),
          createdBy: CAPTURE_AUTHOR,
          initialMessage: { content: withSource(payload.text, sourceUrl) }
        })
        return { id: conversation.id, destination }
      }
      case 'knowledge': {
        const entry = await this.svc.createKnowledge({
          projectId: payload.projectId,
          type: payload.knowledgeType ?? DEFAULT_KNOWLEDGE_TYPE,
          scope: 'project',
          title: deriveTitle(payload, sourceUrl),
          body: withSource(payload.text, sourceUrl),
          refs: []
        })
        return { id: entry.slug, destination }
      }
    }
  }
}
