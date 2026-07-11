// TASK-1330 — the capture contract the browser companion POSTs to /capture, plus
// its validator and the dispatcher port. This module is transport-agnostic: it
// only defines + validates the payload shape. Routing a validated capture onto
// inbox_add / task_create / conversation_* / knowledge_create is TASK-1331's
// dispatcher (the port below); the skeleton wires none, so every valid capture
// 501s until a dispatcher is injected.

export const CAPTURE_KINDS = ['text', 'image', 'network'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

export const CAPTURE_DESTINATIONS = ['inbox', 'task', 'conversation', 'knowledge'] as const
export type CaptureDestination = (typeof CAPTURE_DESTINATIONS)[number]

// Max request body for a capture. Text is the common case; TASK-1332 raises the
// image cap separately. Enforced by the route before parsing.
export const CAPTURE_MAX_BODY_BYTES = 64 * 1024

export interface CaptureRequest {
  kind: CaptureKind
  destination: CaptureDestination
  // Shape is refined per kind by the dispatcher (text string, image data-URL,
  // network record). The contract only requires it to be present.
  payload: unknown
  sourceUrl: string
}

export interface CaptureResult {
  id: string
  destination: CaptureDestination
}

// The port TASK-1331 implements. Kept narrow (one method) so the skeleton can
// omit it and the route falls back to 501 — Open/Closed: dispatch grows without
// editing the route.
export interface CaptureDispatcher {
  dispatch(capture: CaptureRequest): Promise<CaptureResult>
}

// Thrown by a dispatcher when a destination is recognized but not yet wired.
// The route maps it to 501 (distinct from a 400 malformed contract).
export class UnimplementedDestinationError extends Error {
  constructor(destination: CaptureDestination) {
    super(`capture destination not implemented: ${destination}`)
    this.name = 'UnimplementedDestinationError'
  }
}

export type CaptureValidation =
  | { ok: true; value: CaptureRequest }
  | { ok: false; error: string }

function isKind(v: unknown): v is CaptureKind {
  return typeof v === 'string' && (CAPTURE_KINDS as readonly string[]).includes(v)
}

function isDestination(v: unknown): v is CaptureDestination {
  return typeof v === 'string' && (CAPTURE_DESTINATIONS as readonly string[]).includes(v)
}

/**
 * Validate an arbitrary parsed JSON body against the capture contract. Returns a
 * discriminated result so the route can send a specific 400 message. Does NOT
 * validate the per-kind payload shape — that's the dispatcher's job once the kind
 * is known.
 */
export function validateCapture(raw: unknown): CaptureValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'body must be a JSON object' }
  }
  const body = raw as Record<string, unknown>
  if (!isKind(body.kind)) {
    return { ok: false, error: `kind must be one of ${CAPTURE_KINDS.join(', ')}` }
  }
  if (!isDestination(body.destination)) {
    return { ok: false, error: `destination must be one of ${CAPTURE_DESTINATIONS.join(', ')}` }
  }
  if (body.payload === undefined || body.payload === null) {
    return { ok: false, error: 'payload is required' }
  }
  if (typeof body.sourceUrl !== 'string' || body.sourceUrl.length === 0) {
    return { ok: false, error: 'sourceUrl must be a non-empty string' }
  }
  return {
    ok: true,
    value: {
      kind: body.kind,
      destination: body.destination,
      payload: body.payload,
      sourceUrl: body.sourceUrl
    }
  }
}
