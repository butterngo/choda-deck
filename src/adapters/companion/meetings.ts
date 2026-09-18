// TASK-1965 — meeting-audio persistence for the companion recorder (TASK-1963).
//
// Why this is not `/capture`: that route caps a body at CAPTURE_MAX_IMAGE_BYTES
// (5 MB, capture-contract.ts) and answers 413 above it. Every other write route
// on this surface is smaller still — 64 KB in ac-review.ts, 2 MB in
// atomic-file.ts. A one-hour recording is ~55 MB at the 0.92 MB/min that ADR-006
// measured in a real Electron runtime. The audio cannot ride any existing route.
//
// So the bytes arrive in chunks, and chunking is not merely a size workaround:
// the recorder already emits a blob per `timesliceMs` so a long session
// crash-flushes, and one POST per timeslice maps straight onto that. An app
// killed mid-meeting keeps every chunk it had already sent.
//
// Storage is plain files under `<artifactsDir>/meetings/<id>/`, with a meta.json
// sidecar — NOT a SQLite table. `companion-adapter-must-add-zero-mcp-edits`
// establishes this adapter as a thin layer over src/core; a table would mean a
// core schema change and would drag sync in behind it. Capture artifacts already
// work exactly this way.
//
// Reading the audio back is `GET /artifacts/meetings/<id>/<track>.webm` —
// artifacts.ts, not a second byte route. That module already refuses traversal on
// the RAW url and compares the token with timingSafeEqual; duplicating it would
// duplicate the parts that are easy to get wrong.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleTranscribe, readTranscribedAt } from './meeting-transcribe'
import { handleNoteDraft } from './meeting-note'
import { handleMeetingFiles, type RegisteredWorkspace } from './meeting-files'

const ROUTE_PREFIX = '/meetings'

/** Every recording lives under `<artifactsDir>/meetings/`. */
export const MEETINGS_DIR = 'meetings'

/**
 * Per-chunk ceiling. Deliberately the same 5 MB as a capture body: what needed
 * lifting was the TOTAL, not the size of one request. A recorder emitting a
 * chunk every 10 s produces ~150 KB, three orders of magnitude under this.
 */
export const CHUNK_MAX_BYTES = 5 * 1024 * 1024

/**
 * How many finalized recordings survive. Butter chose "keep N most recent" and
 * did not fix N; 20 is ~1.1 GB at 55 MB/hour. One constant to change.
 */
export const RETENTION_COUNT = 20

/** The two streams a meeting records. They are stored separately, never mixed. */
const TRACKS = ['mic', 'loopback'] as const
export type Track = (typeof TRACKS)[number]

/**
 * A meeting id becomes a directory name, so it is checked rather than trusted.
 * Anything outside this alphabet — a dot, a slash, a backslash — is refused
 * before it can reach the filesystem.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface MeetingMeta {
  id: string
  startedAt: string
  endedAt: string
  tracks: Track[]
  bytes: number
  /** TASK-1991 — when transcript.json was last written; null until transcribed. */
  transcribedAt?: string | null
  /**
   * TASK-2003 — when the audio was deliberately deleted to reclaim disk, null
   * while it is still there. The meeting itself survives: the transcript is the
   * durable part, the audio is the expensive part, and a row that vanished with
   * its bytes would be indistinguishable from deleting the meeting.
   */
  audioDeletedAt?: string | null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same constant-time compare as http-server and artifacts, duplicated for the
// same reason they duplicate it: this module stays independently testable.
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

class BodyTooLargeError extends Error {}

/**
 * Read the raw body up to `cap`, draining after an overflow so the client reads
 * our 413 rather than a socket reset. Mirrors http-server's readCappedBody; not
 * imported from there because that one is private to the capture path.
 */
function readCappedBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cl = Number.parseInt(req.headers['content-length'] ?? '', 10)
    if (Number.isFinite(cl) && cl > cap) return reject(new BodyTooLargeError())
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > cap) settle(() => reject(new BodyTooLargeError()))
      else chunks.push(chunk)
    })
    req.on('end', () => settle(() => resolve(Buffer.concat(chunks))))
    req.on('error', (err) => settle(() => reject(err)))
  })
}

function meetingDir(artifactsDir: string, id: string): string {
  return path.join(artifactsDir, MEETINGS_DIR, id)
}

function trackFile(artifactsDir: string, id: string, track: Track): string {
  return path.join(meetingDir(artifactsDir, id), `${track}.webm`)
}

/**
 * Last accepted sequence number for one track, or -1 when nothing has been
 * accepted yet. Kept in a sidecar rather than in memory so the answer survives an
 * adapter restart — the recorder's whole point is surviving a crash, and an
 * in-memory counter would forget precisely when that matters.
 */
function seqFile(artifactsDir: string, id: string, track: Track): string {
  return path.join(meetingDir(artifactsDir, id), `${track}.seq`)
}

function readSeq(artifactsDir: string, id: string, track: Track): number {
  try {
    const n = Number.parseInt(fs.readFileSync(seqFile(artifactsDir, id, track), 'utf8').trim(), 10)
    return Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

export function readMeta(artifactsDir: string, id: string): MeetingMeta | null {
  try {
    const raw = fs.readFileSync(path.join(meetingDir(artifactsDir, id), 'meta.json'), 'utf8')
    const parsed = JSON.parse(raw) as MeetingMeta
    return typeof parsed?.id === 'string' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Every FINALIZED recording, newest first.
 *
 * A directory without meta.json is a recording still in progress — it is skipped
 * here and, more importantly, never evicted. Evicting one would delete a meeting
 * while it was being recorded.
 */
export function listMeetings(artifactsDir: string): MeetingMeta[] {
  const root = path.join(artifactsDir, MEETINGS_DIR)
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => readMeta(artifactsDir, e.name))
    .filter((m): m is MeetingMeta => m !== null)
    .map((m) => ({ ...m, transcribedAt: readTranscribedAt(artifactsDir, m.id) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/**
 * DELETE /meetings/:id/audio — reclaim the expensive half of a meeting.
 *
 * Deliberately NOT `evictOldest` with one id. That function removes the whole
 * directory, transcript included; this one removes only the `.webm` files and
 * leaves meta.json and transcript.json in place, so the meeting stays listed and
 * readable. The two are opposites and must not share an implementation.
 *
 * Idempotent: a meeting whose audio is already gone answers 200 with
 * `freedBytes: 0`, because "make the audio not exist" is already true.
 */
function deleteMeetingAudio(res: ServerResponse, artifactsDir: string, id: string): void {
  const dir = meetingDir(artifactsDir, id)
  if (!fs.existsSync(dir)) {
    sendJson(res, 404, { error: 'meeting not found' })
    return
  }
  const meta = readMeta(artifactsDir, id)
  // No meta.json means a recording still being written to (listMeetings skips
  // these for the same reason). Deleting its tracks mid-flight would leave the
  // recorder appending to a file nothing will ever finalize.
  if (!meta || !meta.endedAt) {
    sendJson(res, 409, { error: 'not finalized' })
    return
  }

  let freedBytes = 0
  for (const track of TRACKS) {
    const file = trackFile(artifactsDir, id, track)
    try {
      freedBytes += fs.statSync(file).size
      fs.rmSync(file)
    } catch {
      /* already gone — the idempotent case, and it contributes no bytes */
    }
  }

  // Written after the unlinks: a crash between them re-runs as the idempotent
  // case, whereas stamping first would claim a deletion that did not happen.
  if (freedBytes > 0 || !meta.audioDeletedAt) {
    const next: MeetingMeta = { ...meta, bytes: 0, audioDeletedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(next))
  }
  sendJson(res, 200, { id, freedBytes })
}

/**
 * Drop the oldest finalized recordings until at most `keep` remain. Returns the
 * ids removed. In-progress recordings are invisible to this (see listMeetings).
 */
export function evictOldest(artifactsDir: string, keep: number = RETENTION_COUNT): string[] {
  const all = listMeetings(artifactsDir) // newest first
  const doomed = all.slice(keep)
  for (const m of doomed) {
    fs.rmSync(meetingDir(artifactsDir, m.id), { recursive: true, force: true })
  }
  return doomed.map((m) => m.id)
}

function parseTrack(value: string | null): Track | null {
  return TRACKS.includes(value as Track) ? (value as Track) : null
}

/**
 * POST /meetings/:id/chunk?track=mic|loopback&seq=N
 * POST /meetings/:id/finalize
 * POST /meetings/:id/transcribe   (TASK-1991 — meeting-transcribe.ts)
 * POST /meetings/:id/note/draft   (TASK-1992 — meeting-note.ts)
 * PUT  /meetings/:id/files        (TASK-1994 — meeting-files.ts)
 * GET  /meetings
 *
 * Returns false when the request isn't ours, so the caller falls through to the
 * rest of the router — same shape as handleArtifactsRoute / handleKnowledgeRoute.
 */
export async function handleMeetingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    artifactsDir?: string
    bridgeToken: string
    retentionCount?: number
    speechCredentialsFile?: string
    /** TASK-1992 — where ai-provider.json and ai-key.txt live. */
    dataDir?: string
    /** TASK-1992 — injectable model transport for tests. */
    fetchImpl?: typeof fetch
    /** TASK-1994 — vault root for saved transcripts and notes; absent → 501. */
    vaultDir?: string
    /** TASK-1994 — registry lookup; the repo copy's folder comes only from here. */
    findWorkspace?: (id: string) => Promise<RegisteredWorkspace | null>
  }
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname
  if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) return false

  const method = req.method ?? 'GET'

  // Token first — these files are a recording of a client conversation, which is
  // at least as sensitive as the screenshots artifacts.ts already gates.
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  // Symmetric with artifacts.ts: well-formed request, server not configured.
  if (!opts.artifactsDir) {
    sendJson(res, 501, { error: 'meeting storage not configured' })
    return true
  }
  const artifactsDir = opts.artifactsDir
  const keep = opts.retentionCount ?? RETENTION_COUNT

  if (pathname === ROUTE_PREFIX) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    sendJson(res, 200, listMeetings(artifactsDir))
    return true
  }

  const rest = pathname.slice(ROUTE_PREFIX.length + 1).split('/')
  const [id, action] = rest

  // TASK-1992 — the one three-segment route. Matched before the two-segment
  // check below, which would otherwise answer it with a 400.
  if (rest.length === 3 && action === 'note' && rest[2] === 'draft' && ID_RE.test(id ?? '')) {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await handleNoteDraft(req, res, {
      artifactsDir,
      id,
      dataDir: opts.dataDir,
      fetchImpl: opts.fetchImpl
    })
    return true
  }

  // TASK-2003 — the one DELETE on this prefix. Matched before the POST-only
  // guard below, which would otherwise answer it with a 405.
  if (rest.length === 2 && action === 'audio' && ID_RE.test(id ?? '')) {
    if (method !== 'DELETE') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    deleteMeetingAudio(res, artifactsDir, id)
    return true
  }

  // TASK-1994 — the one PUT on this prefix. Matched before the POST-only guard
  // below, which would otherwise answer it with a 405.
  if (rest.length === 2 && action === 'files' && ID_RE.test(id ?? '')) {
    if (method !== 'PUT') {
      sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    await handleMeetingFiles(req, res, {
      vaultDir: opts.vaultDir,
      findWorkspace: opts.findWorkspace ?? (async () => null)
    })
    return true
  }

  if (rest.length !== 2 || !ID_RE.test(id ?? '')) {
    sendJson(res, 400, { error: 'expected /meetings/<id>/chunk or /meetings/<id>/finalize' })
    return true
  }
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  if (action === 'chunk') {
    const track = parseTrack(url.searchParams.get('track'))
    if (!track) {
      sendJson(res, 400, { error: `track must be one of ${TRACKS.join('|')}` })
      return true
    }
    const seq = Number.parseInt(url.searchParams.get('seq') ?? '', 10)
    if (!Number.isInteger(seq) || seq < 0) {
      sendJson(res, 400, { error: 'seq must be a non-negative integer' })
      return true
    }

    let body: Buffer
    try {
      body = await readCappedBody(req, CHUNK_MAX_BYTES)
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: `chunk exceeds ${CHUNK_MAX_BYTES} bytes` })
        return true
      }
      throw err
    }

    // Gap-or-repeat check BEFORE touching the file. A repeat would double-append
    // and a gap would silently produce a file with a hole in the middle that
    // still decodes — the worst kind of corruption, because it looks fine.
    const last = readSeq(artifactsDir, id, track)
    if (seq !== last + 1) {
      sendJson(res, 409, { error: `expected seq ${last + 1}, got ${seq}`, expected: last + 1 })
      return true
    }

    fs.mkdirSync(meetingDir(artifactsDir, id), { recursive: true })
    fs.appendFileSync(trackFile(artifactsDir, id, track), body)
    // Written AFTER the append: a crash between the two re-offers this seq, and
    // the client's retry is accepted. The other order would acknowledge bytes
    // that never landed, which loses audio instead of duplicating a request.
    fs.writeFileSync(seqFile(artifactsDir, id, track), String(seq), 'utf8')

    sendJson(res, 200, { bytes: body.length, seq })
    return true
  }

  if (action === 'transcribe') {
    await handleTranscribe(res, {
      artifactsDir,
      id,
      speechCredentialsFile: opts.speechCredentialsFile
    })
    return true
  }

  if (action === 'finalize') {
    const dir = meetingDir(artifactsDir, id)
    if (!fs.existsSync(dir)) {
      sendJson(res, 404, { error: 'no such meeting' })
      return true
    }

    // Declared without an initializer so its type comes from readCappedBody —
    // Buffer.alloc(0) would pin it to Buffer<ArrayBuffer> and reject the read.
    let raw: Buffer
    try {
      raw = await readCappedBody(req, 64 * 1024)
    } catch {
      // A finalize body is optional; an unreadable one is not worth failing on.
      raw = Buffer.alloc(0)
    }
    let given: Partial<MeetingMeta> = {}
    if (raw.length > 0) {
      try {
        given = JSON.parse(raw.toString('utf8')) as Partial<MeetingMeta>
      } catch {
        sendJson(res, 400, { error: 'body is not valid JSON' })
        return true
      }
    }

    const tracks: Track[] = []
    let bytes = 0
    for (const track of TRACKS) {
      try {
        bytes += fs.statSync(trackFile(artifactsDir, id, track)).size
        tracks.push(track)
      } catch {
        // Track never recorded — a mic-less machine still finalizes cleanly.
      }
    }

    const meta: MeetingMeta = {
      id,
      // Fall back to the directory's own birth time so a client that forgets to
      // send startedAt still sorts and evicts correctly.
      startedAt: given.startedAt ?? fs.statSync(dir).birthtime.toISOString(),
      endedAt: given.endedAt ?? new Date().toISOString(),
      tracks,
      bytes
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')

    const evicted = evictOldest(artifactsDir, keep)
    sendJson(res, 200, evicted.length ? { ...meta, evicted } : meta)
    return true
  }

  sendJson(res, 404, { error: 'unknown meeting action' })
  return true
}
