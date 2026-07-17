// TASK-1330 — the capture contract the browser companion POSTs to /capture, plus
// its validator and the dispatcher port. This module is transport-agnostic: it
// only defines + validates the payload shape. Routing a validated capture onto
// inbox_add / task_create / conversation_* / knowledge_create is TASK-1331's
// dispatcher (the port below); the skeleton wires none, so every valid capture
// 501s until a dispatcher is injected.

export const CAPTURE_KINDS = ['text', 'image', 'network', 'network-bundle', 'discovery-session'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

// ---- Discovery session timeline (TASK-1410) ---------------------------------
// A recorded browsing session = one timestamp-ordered timeline of events. The
// extension buffers these client-side and POSTs one finalized bundle at Stop.
// The envelope validator (validateCapture) only checks the outer contract; the
// per-event shape below is parsed by the dispatcher via capture-artifacts.

export interface DiscoveryEventBase {
  ts: number
  url?: string
}
export interface DiscoveryNavEvent extends DiscoveryEventBase {
  type: 'nav'
  title?: string
}
export interface DiscoveryClickEvent extends DiscoveryEventBase {
  type: 'click'
  selector: string
  text?: string
}
export interface DiscoveryInputEvent extends DiscoveryEventBase {
  type: 'input'
  selector: string
  // Already redacted at capture time in the page (TASK-1411) — never a raw secret.
  value: string
}
export interface DiscoveryApiEvent extends DiscoveryEventBase {
  type: 'apicall'
  method: string
  status?: number
  // Response body — redacted + capped in-page at capture time (TASK-1419).
  body?: string
}
export interface DiscoverySnapshotEvent extends DiscoveryEventBase {
  type: 'snapshot'
  // References a DiscoverySnapshot.id carried in the bundle's snapshots[].
  snapshotId: string
}
export type DiscoveryEvent =
  | DiscoveryNavEvent
  | DiscoveryClickEvent
  | DiscoveryInputEvent
  | DiscoveryApiEvent
  | DiscoverySnapshotEvent

// A per-step DOM snapshot (TASK-1413 fills html/css/screenshot; redacted in-page).
export interface DiscoverySnapshot {
  id: string
  html?: string
  css?: string
  // base64 data URL — decoded + written to disk locally, never synced.
  screenshotDataUrl?: string
}

export interface DiscoverySessionBundle {
  projectId: string
  label?: string
  startedAt?: number
  endedAt?: number
  events: DiscoveryEvent[]
  snapshots?: DiscoverySnapshot[]
}

export const CAPTURE_DESTINATIONS = ['inbox', 'task', 'conversation', 'knowledge'] as const
export type CaptureDestination = (typeof CAPTURE_DESTINATIONS)[number]

// Per-kind body caps, enforced by the route against the raw request bytes. Text
// and network payloads are small (a selection / a headers record); image carries
// a base64 screenshot, so it gets a larger ceiling. The route reads up to the
// image cap (memory ceiling) then rejects a body over its kind's cap with 413.
export const CAPTURE_MAX_TEXT_BYTES = 64 * 1024
export const CAPTURE_MAX_IMAGE_BYTES = 5 * 1024 * 1024

export function capForKind(kind: CaptureKind): number {
  // network-bundle carries many records (with optional bodies), so it shares the
  // image ceiling rather than the single-record 64 KB cap.
  return kind === 'image' || kind === 'network-bundle' || kind === 'discovery-session'
    ? CAPTURE_MAX_IMAGE_BYTES
    : CAPTURE_MAX_TEXT_BYTES
}

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

// Base for "the contract was valid but this capture can't be routed yet". The
// route maps any subclass to 501 (distinct from a 400 malformed contract).
export class CaptureNotImplementedError extends Error {}

// Destination recognized but not yet wired.
export class UnimplementedDestinationError extends CaptureNotImplementedError {
  constructor(destination: CaptureDestination) {
    super(`capture destination not implemented: ${destination}`)
    this.name = 'UnimplementedDestinationError'
  }
}

// Kind recognized by the contract but not yet handled by the dispatcher (e.g.
// image/network before TASK-1332). Also 501.
export class UnimplementedKindError extends CaptureNotImplementedError {
  constructor(kind: CaptureKind) {
    super(`capture kind not implemented: ${kind}`)
    this.name = 'UnimplementedKindError'
  }
}

// Thrown by the dispatcher when the per-kind payload is malformed (the contract
// validator only checks envelope shape, not payload internals). Route → 400.
export class CaptureBadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureBadRequestError'
  }
}

// Thrown by the dispatcher when the payload names a projectId that doesn't exist.
// Distinct from CaptureBadRequestError: the contract is well-formed, the referent
// isn't there. Route → 404.
export class CaptureNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureNotFoundError'
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
