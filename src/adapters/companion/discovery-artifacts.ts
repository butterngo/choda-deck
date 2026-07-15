// TASK-1410 — parse + persist a discovery-session bundle. A recorded browsing
// session is buffered client-side and POSTed as one finalized bundle at Stop;
// here it is validated and written LOCAL-ONLY as:
//   captures/discovery-<id>/timeline.jsonl   — one event per line (machine-first)
//   captures/discovery-<id>/draft.md         — readable flow summary (human-first)
//   captures/discovery-<id>/snapshots/<sid>.{html,css,png}
// The raw artifact never leaves disk; only a sanitized summary + pointer is synced
// (gotcha: secret-carrying-capture-kinds-are-local-only). Redaction of values /
// DOM happens in-page at capture time (TASK-1411), not here.

import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import {
  CaptureBadRequestError,
  type DiscoveryEvent,
  type DiscoverySessionBundle,
  type DiscoverySnapshot
} from './capture-contract'

const DISCOVERY_EVENT_TYPES = ['nav', 'click', 'input', 'apicall', 'snapshot'] as const
const SCREENSHOT_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,([a-z0-9+/=]+)$/i
const SCREENSHOT_EXT: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' }

export interface DiscoverySessionArtifact {
  // Absolute session dir + the two canonical files.
  dir: string
  timelinePath: string
  draftPath: string
  // Path relative to the artifacts root — safe to put in the synced inbox row.
  relDir: string
  eventCount: number
  navCount: number
  apiCount: number
  snapshotCount: number
  bytes: number
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function reqStr(o: Record<string, unknown>, key: string, hint: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.length === 0) throw new CaptureBadRequestError(hint)
  return v
}

function parseEvent(raw: unknown, i: number): DiscoveryEvent {
  if (!isObj(raw)) throw new CaptureBadRequestError(`event[${i}] must be an object`)
  const type = raw.type
  if (typeof type !== 'string' || !(DISCOVERY_EVENT_TYPES as readonly string[]).includes(type)) {
    throw new CaptureBadRequestError(`event[${i}].type must be one of ${DISCOVERY_EVENT_TYPES.join(', ')}`)
  }
  if (typeof raw.ts !== 'number') throw new CaptureBadRequestError(`event[${i}].ts must be a number`)
  const url = typeof raw.url === 'string' ? raw.url : undefined
  switch (type) {
    case 'nav':
      return { type, ts: raw.ts, url, title: typeof raw.title === 'string' ? raw.title : undefined }
    case 'click':
      return {
        type,
        ts: raw.ts,
        url,
        selector: reqStr(raw, 'selector', `event[${i}].selector required`),
        text: typeof raw.text === 'string' ? raw.text : undefined
      }
    case 'input':
      return {
        type,
        ts: raw.ts,
        url,
        selector: reqStr(raw, 'selector', `event[${i}].selector required`),
        value: typeof raw.value === 'string' ? raw.value : ''
      }
    case 'apicall':
      return {
        type,
        ts: raw.ts,
        url,
        method: reqStr(raw, 'method', `event[${i}].method required`),
        status: typeof raw.status === 'number' ? raw.status : undefined
      }
    default:
      // snapshot
      return { type: 'snapshot', ts: raw.ts, url, snapshotId: reqStr(raw, 'snapshotId', `event[${i}].snapshotId required`) }
  }
}

function parseSnapshot(raw: unknown, i: number): DiscoverySnapshot {
  if (!isObj(raw)) throw new CaptureBadRequestError(`snapshot[${i}] must be an object`)
  return {
    id: reqStr(raw, 'id', `snapshot[${i}].id required`),
    html: typeof raw.html === 'string' ? raw.html : undefined,
    css: typeof raw.css === 'string' ? raw.css : undefined,
    screenshotDataUrl: typeof raw.screenshotDataUrl === 'string' ? raw.screenshotDataUrl : undefined
  }
}

/** Narrow an arbitrary capture payload into a DiscoverySessionBundle, or throw 400. */
export function parseDiscoveryBundle(payload: unknown): DiscoverySessionBundle {
  if (!isObj(payload)) {
    throw new CaptureBadRequestError('discovery-session payload must be an object { projectId, events, ... }')
  }
  const projectId = reqStr(payload, 'projectId', 'discovery-session payload requires a "projectId"')
  if (!Array.isArray(payload.events) || payload.events.length === 0) {
    throw new CaptureBadRequestError('discovery-session payload requires a non-empty "events" array')
  }
  const events = payload.events.map((e, i) => parseEvent(e, i))
  const snapshots = Array.isArray(payload.snapshots)
    ? payload.snapshots.map((s, i) => parseSnapshot(s, i))
    : undefined
  return {
    projectId,
    label: typeof payload.label === 'string' ? payload.label : undefined,
    startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : undefined,
    endedAt: typeof payload.endedAt === 'number' ? payload.endedAt : undefined,
    events,
    snapshots
  }
}

function writeSnapshots(dir: string, snapshots: DiscoverySnapshot[]): number {
  const snapDir = path.join(dir, 'snapshots')
  fs.mkdirSync(snapDir, { recursive: true })
  let bytes = 0
  for (const s of snapshots) {
    if (s.html !== undefined) {
      const p = path.join(snapDir, `${s.id}.html`)
      fs.writeFileSync(p, s.html, 'utf8')
      bytes += Buffer.byteLength(s.html)
    }
    if (s.css !== undefined) {
      const p = path.join(snapDir, `${s.id}.css`)
      fs.writeFileSync(p, s.css, 'utf8')
      bytes += Buffer.byteLength(s.css)
    }
    if (s.screenshotDataUrl !== undefined) {
      const m = SCREENSHOT_DATA_URL_RE.exec(s.screenshotDataUrl)
      if (m) {
        const ext = SCREENSHOT_EXT[m[1].toLowerCase()]
        const buf = Buffer.from(m[2], 'base64')
        if (ext && buf.length > 0) {
          fs.writeFileSync(path.join(snapDir, `${s.id}.${ext}`), buf)
          bytes += buf.length
        }
      }
    }
  }
  return bytes
}

function eventLine(e: DiscoveryEvent): string {
  switch (e.type) {
    case 'nav':
      return `- nav → ${e.url ?? ''}${e.title ? ` (${e.title})` : ''}`
    case 'click':
      return `- click \`${e.selector}\`${e.text ? ` "${e.text}"` : ''}`
    case 'input':
      return `- input \`${e.selector}\` = ${e.value}`
    case 'apicall':
      return `- api ${e.method} ${e.url ?? ''}${e.status !== undefined ? ` → ${e.status}` : ''}`
    default:
      return `- snapshot ${e.snapshotId}${e.url ? ` @ ${e.url}` : ''}`
  }
}

function buildDraft(bundle: DiscoverySessionBundle, relDir: string): string {
  const pages = new Set(
    bundle.events.filter((e) => e.type === 'nav').map((e) => (e as { url?: string }).url ?? '')
  )
  const apis = bundle.events.filter((e) => e.type === 'apicall').length
  const snaps = bundle.snapshots?.length ?? 0
  const header =
    `# Discovery session${bundle.label ? ` — ${bundle.label}` : ''}\n\n` +
    `${bundle.events.length} events · ${pages.size} pages · ${apis} API calls · ${snaps} snapshots\n\n` +
    `Raw timeline: \`${relDir}/timeline.jsonl\`\n\n## Flow\n\n`
  return header + bundle.events.map(eventLine).join('\n') + '\n'
}

/**
 * Write a validated bundle under `<artifactsDir>/captures/discovery-<id>/` and
 * return the paths + counts. Everything stays local; nothing here is synced.
 */
export function writeDiscoverySession(
  artifactsDir: string,
  bundle: DiscoverySessionBundle
): DiscoverySessionArtifact {
  const id = randomBytes(8).toString('hex')
  const relDir = path.join('captures', `discovery-${id}`)
  const dir = path.join(artifactsDir, relDir)
  fs.mkdirSync(dir, { recursive: true })

  const jsonl = bundle.events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  const timelinePath = path.join(dir, 'timeline.jsonl')
  fs.writeFileSync(timelinePath, jsonl, 'utf8')

  let bytes = Buffer.byteLength(jsonl)
  if (bundle.snapshots && bundle.snapshots.length > 0) {
    bytes += writeSnapshots(dir, bundle.snapshots)
  }

  const draft = buildDraft(bundle, relDir.split(path.sep).join('/'))
  const draftPath = path.join(dir, 'draft.md')
  fs.writeFileSync(draftPath, draft, 'utf8')
  bytes += Buffer.byteLength(draft)

  return {
    dir,
    timelinePath,
    draftPath,
    relDir: relDir.split(path.sep).join('/'),
    eventCount: bundle.events.length,
    navCount: bundle.events.filter((e) => e.type === 'nav').length,
    apiCount: bundle.events.filter((e) => e.type === 'apicall').length,
    snapshotCount: bundle.snapshots?.length ?? 0,
    bytes
  }
}
