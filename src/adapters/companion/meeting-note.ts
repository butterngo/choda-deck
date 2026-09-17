// TASK-1992 — draft a meeting note from transcript.json.
//
// The note exists to be evidence when a client disputes what was agreed, so the
// one rule that matters is enforced HERE, not in the prompt: every decision,
// action, question, request and number must point at a moment that is actually
// in the recording. The model is asked to cite a segment start for each item; the
// adapter then checks that citation against the transcript and moves anything
// that fails into `dropped[]` with the reason. A prompt instruction alone is not
// a control — the model can ignore it and nothing would notice.
//
// Four more rules come from the real call TASK-1990 measured (ADR
// `adr-meeting-transcription-azure-speech-fast-per-track-audio-leaves-the-laptop`),
// and each is applied by code for the same reason:
//
//   * Language is per meeting, default Vietnamese, and headings come from a fixed
//     table below — never from the model.
//   * Loopback is "whoever is on the other end". That call became an internal
//     debrief halfway through on the same recording, so the request marks parts
//     `client` / `internal` and internal items are dropped unless asked for.
//   * English terms inside Vietnamese sentences are mis-heard ("comparency" for
//     competency). The glossary is handed to the model AND applied to its output
//     here, so a correction does not depend on the model choosing to use it.
//   * The same count came back as both "5" and "8". A number is returned with
//     every moment it was said; disagreeing values are flagged, not averaged.
//
// Client, project and attendee names come from the request. The transcript never
// named the client on that call, and a model asked to guess will.
//
// Nothing is written: this returns a draft. Saving is TASK-1994's, after review.

import * as fs from 'fs'
import * as path from 'path'
import type { IncomingMessage, ServerResponse } from 'http'
import { AiError } from './ai-review'
import { askAzureJson, resolveAzureConfig } from './azure-review'
import type { TranscriptSegment } from './meeting-transcribe'

const MEETINGS_DIR = 'meetings'
const MAX_BODY_BYTES = 64 * 1024

export type NoteLanguage = 'vi' | 'en'

export const HEADINGS: Record<
  NoteLanguage,
  Record<'tldr' | 'decisions' | 'actions' | 'questions' | 'requests' | 'numbers' | 'topics' | 'transcript', string>
> = {
  vi: {
    tldr: '## Tóm tắt',
    decisions: '## Quyết định',
    actions: '## Việc cần làm',
    questions: '## Câu hỏi mở / rủi ro',
    requests: '## Yêu cầu & băn khoăn của khách',
    numbers: '## Con số & thuật ngữ quan trọng',
    topics: '## Nội dung thảo luận (theo chủ đề)',
    transcript: '## Transcript'
  },
  en: {
    tldr: '## TL;DR',
    decisions: '## Decisions',
    actions: '## Action items',
    questions: '## Open questions / risks',
    requests: '## Client requests & concerns',
    numbers: '## Key numbers & terms',
    topics: '## Discussion (by topic)',
    transcript: '## Transcript'
  }
}

const COLUMNS: Record<NoteLanguage, { decision: string; who: string; evidence: string; owner: string; action: string; due: string }> = {
  vi: { decision: 'Quyết định', who: 'Ai đồng ý', evidence: 'Bằng chứng', owner: 'Người làm', action: 'Việc', due: 'Hạn' },
  en: { decision: 'Decision', who: 'Who agreed', evidence: 'Evidence', owner: 'Owner', action: 'Action', due: 'Due' }
}

export interface NoteItem {
  text: string
  atMs: number
  who?: string
}

export interface NoteNumber extends NoteItem {
  values: Array<{ value: string; atMs: number }>
  conflict: boolean
}

export interface Note {
  tldr: string
  decisions: NoteItem[]
  actions: Array<NoteItem & { owner: string; due: string | null }>
  questions: NoteItem[]
  requests: NoteItem[]
  numbers: NoteNumber[]
  topics: Array<{ title: string; fromMs: number; toMs: number; bullets: string[] }>
}

export type DropReason = 'no-timestamp' | 'outside-segments' | 'internal-part'

export interface Dropped {
  section: string
  text: string
  atMs: number | null
  reason: DropReason
}

interface Part {
  fromMs: number
  toMs: number
  kind: 'client' | 'internal'
}

interface GlossaryEntry {
  heard: string[]
  term: string
}

export interface DraftRequest {
  client: string
  project: string | null
  topic?: string
  attendees?: string[]
  language: NoteLanguage
  parts?: Part[]
  includeInternal: boolean
  glossary?: GlossaryEntry[]
}

// ---- what the model is asked to return -------------------------------------------

interface ModelItem {
  text: string
  atMs: number | null
  who: string | null
}

interface ModelNote {
  tldr: string
  decisions: ModelItem[]
  actions: Array<ModelItem & { owner: string; due: string | null }>
  questions: ModelItem[]
  requests: ModelItem[]
  numbers: Array<{ text: string; values: Array<{ value: string; atMs: number | null }> }>
  topics: Array<{ title: string; fromMs: number; toMs: number; bullets: string[] }>
}

const ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'atMs', 'who'],
  properties: {
    text: { type: 'string' },
    atMs: { type: ['integer', 'null'] },
    who: { type: ['string', 'null'] }
  }
} as const

export const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tldr', 'decisions', 'actions', 'questions', 'requests', 'numbers', 'topics'],
  properties: {
    tldr: { type: 'string' },
    decisions: { type: 'array', items: ITEM },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'atMs', 'who', 'owner', 'due'],
        properties: { ...ITEM.properties, owner: { type: 'string' }, due: { type: ['string', 'null'] } }
      }
    },
    questions: { type: 'array', items: ITEM },
    requests: { type: 'array', items: ITEM },
    numbers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'values'],
        properties: {
          text: { type: 'string' },
          values: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'atMs'],
              properties: { value: { type: 'string' }, atMs: { type: ['integer', 'null'] } }
            }
          }
        }
      }
    },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'fromMs', 'toMs', 'bullets'],
        properties: {
          title: { type: 'string' },
          fromMs: { type: 'integer' },
          toMs: { type: 'integer' },
          bullets: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
} as const

// ---- pure helpers (exported for tests) -----------------------------------------

/** `▶ mm:ss`, or `▶ h:mm:ss` from one hour on. */
export function formatAt(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `▶ ${h}:${pad(m)}:${pad(s)}` : `▶ ${pad(m)}:${pad(s)}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Replace each mis-heard form with its term, whole words only, case-insensitive. */
export function applyGlossary(text: string, glossary: GlossaryEntry[] | undefined): string {
  if (!glossary?.length) return text
  let out = text
  for (const entry of glossary) {
    for (const heard of entry.heard) {
      if (!heard.trim()) continue
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(heard)}(?![\\p{L}\\p{N}])`, 'giu')
      out = out.replace(re, entry.term)
    }
  }
  return out
}

function inSegments(atMs: number, segments: TranscriptSegment[]): boolean {
  return segments.some((s) => s.startMs <= atMs && atMs <= s.endMs)
}

function isInternal(atMs: number, parts: Part[] | undefined): boolean {
  return (parts ?? []).some((p) => p.kind === 'internal' && p.fromMs <= atMs && atMs < p.toMs)
}

/** Why an item may not appear in the note, or null when it may. */
function anchorFailure(
  atMs: number | null | undefined,
  segments: TranscriptSegment[],
  req: DraftRequest
): DropReason | null {
  if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return 'no-timestamp'
  if (!inSegments(atMs, segments)) return 'outside-segments'
  if (!req.includeInternal && isInternal(atMs, req.parts)) return 'internal-part'
  return null
}

/** Apply every rule the adapter owns to what the model said. */
export function enforce(
  model: ModelNote,
  segments: TranscriptSegment[],
  req: DraftRequest
): { note: Note; dropped: Dropped[] } {
  const dropped: Dropped[] = []
  const g = (s: string): string => applyGlossary(s, req.glossary)

  function keep<T extends ModelItem, U>(section: string, items: T[], shape: (i: T, atMs: number) => U): U[] {
    const out: U[] = []
    for (const item of items ?? []) {
      const reason = anchorFailure(item.atMs, segments, req)
      if (reason) {
        dropped.push({ section, text: g(item.text), atMs: item.atMs ?? null, reason })
        continue
      }
      out.push(shape(item, item.atMs as number))
    }
    return out
  }

  const plain = (i: ModelItem, atMs: number): NoteItem => ({
    text: g(i.text),
    atMs,
    ...(i.who ? { who: i.who } : {})
  })

  const numbers: NoteNumber[] = []
  for (const n of model.numbers ?? []) {
    const reasons = (n.values ?? []).map((v) => anchorFailure(v.atMs, segments, req))
    const values = (n.values ?? [])
      .filter((_, i) => reasons[i] === null)
      .map((v) => ({ value: v.value, atMs: v.atMs as number }))
      .sort((a, b) => a.atMs - b.atMs)
    if (values.length === 0) {
      const first = n.values?.[0]
      dropped.push({
        section: 'numbers',
        text: g(n.text),
        atMs: first?.atMs ?? null,
        reason: reasons.find((r): r is DropReason => r !== null) ?? 'no-timestamp'
      })
      continue
    }
    const distinct = new Set(values.map((v) => v.value.trim().toLowerCase()))
    numbers.push({ text: g(n.text), atMs: values[0].atMs, values, conflict: distinct.size > 1 })
  }

  const note: Note = {
    tldr: g(model.tldr ?? ''),
    decisions: keep('decisions', model.decisions, plain),
    actions: keep('actions', model.actions, (i, atMs) => ({
      ...plain(i, atMs),
      owner: i.owner,
      due: i.due ?? null
    })),
    questions: keep('questions', model.questions, plain),
    requests: keep('requests', model.requests, plain),
    numbers,
    topics: (model.topics ?? []).map((t) => ({
      title: g(t.title),
      fromMs: t.fromMs,
      toMs: t.toMs,
      bullets: (t.bullets ?? []).map(g)
    }))
  }
  return { note, dropped }
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderMarkdown(
  note: Note,
  segments: TranscriptSegment[],
  req: DraftRequest,
  meetingId: string
): string {
  const h = HEADINGS[req.language]
  const c = COLUMNS[req.language]
  const lines: string[] = []

  // The title is built from the request only. The model never gets to name the client.
  lines.push(`# ${req.client}${req.topic ? ` — ${req.topic}` : ''}`)
  const who = [`Butter (mic)`, ...(req.attendees?.length ? [`${req.attendees.join(', ')} (loopback)`] : [])]
  lines.push('')
  lines.push(`**${req.language === 'vi' ? 'Tham dự' : 'Attendees'}:** ${who.join(' · ')}`)
  lines.push(`**${req.language === 'vi' ? 'Bản ghi' : 'Recording'}:** ${meetingId}${req.project ? ` · ${req.project}` : ''}`)

  lines.push('', h.tldr, note.tldr)

  lines.push('', h.decisions, `| # | ${c.decision} | ${c.who} | ${c.evidence} |`, '|---|---|---|---|')
  note.decisions.forEach((d, i) =>
    lines.push(`| D${i + 1} | ${cell(d.text)} | ${cell(d.who ?? '')} | ${formatAt(d.atMs)} |`)
  )

  lines.push('', h.actions, `| # | ${c.owner} | ${c.action} | ${c.due} | ${c.evidence} |`, '|---|---|---|---|---|')
  note.actions.forEach((a, i) =>
    lines.push(`| A${i + 1} | ${cell(a.owner)} | ${cell(a.text)} | ${cell(a.due ?? '—')} | ${formatAt(a.atMs)} |`)
  )

  lines.push('', h.questions)
  for (const q of note.questions) lines.push(`- ${q.text} ${formatAt(q.atMs)}`)

  lines.push('', h.requests)
  for (const r of note.requests) lines.push(`- ${r.text} ${formatAt(r.atMs)}`)

  lines.push('', h.numbers)
  for (const n of note.numbers) {
    const said = n.values.map((v) => `"${v.value}" ${formatAt(v.atMs)}`).join(' · ')
    lines.push(`- ${n.conflict ? '⚠ ' : ''}**${n.text}:** ${said}`)
  }

  lines.push('', h.topics)
  for (const t of note.topics) {
    lines.push(`### ${t.title} ${formatAt(t.fromMs)}–${formatAt(t.toMs).slice(2)}`)
    for (const b of t.bullets) lines.push(`- ${b}`)
  }

  lines.push('', h.transcript)
  for (const s of segments) {
    const total = Math.floor(s.startMs / 1000)
    const stamp = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
      .map((n) => String(n).padStart(2, '0'))
      .join(':')
    lines.push(`[${stamp}] ${s.speaker}: ${applyGlossary(s.text, req.glossary)}`)
  }
  return lines.join('\n') + '\n'
}

// ---- request handling ----------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** The validated request, or the 400 message explaining why it is not one. */
export function parseDraftRequest(raw: unknown): DraftRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object'
  const b = raw as Record<string, unknown>
  if (typeof b.client !== 'string' || b.client.trim() === '') return 'client is required'
  const language = b.language ?? 'vi'
  if (language !== 'vi' && language !== 'en') return "language must be 'vi' or 'en'"

  let parts: Part[] | undefined
  if (b.parts !== undefined) {
    if (!Array.isArray(b.parts)) return 'parts must be an array'
    parts = []
    for (const p of b.parts as Array<Record<string, unknown>>) {
      if (
        typeof p?.fromMs !== 'number' ||
        typeof p?.toMs !== 'number' ||
        (p.kind !== 'client' && p.kind !== 'internal')
      ) {
        return 'each part needs numeric fromMs, toMs and kind client|internal'
      }
      if (p.fromMs >= p.toMs) return 'a part must have fromMs < toMs'
      parts.push({ fromMs: p.fromMs, toMs: p.toMs, kind: p.kind })
    }
    const sorted = [...parts].sort((a, x) => a.fromMs - x.fromMs)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].fromMs < sorted[i - 1].toMs) return 'parts must not overlap'
    }
  }

  let glossary: GlossaryEntry[] | undefined
  if (b.glossary !== undefined) {
    if (!Array.isArray(b.glossary)) return 'glossary must be an array'
    glossary = []
    for (const e of b.glossary as Array<Record<string, unknown>>) {
      if (!Array.isArray(e?.heard) || typeof e?.term !== 'string') return 'glossary entries need heard[] and term'
      glossary.push({ heard: (e.heard as unknown[]).filter((x): x is string => typeof x === 'string'), term: e.term })
    }
  }

  return {
    client: b.client.trim(),
    project: typeof b.project === 'string' ? b.project : null,
    topic: typeof b.topic === 'string' && b.topic.trim() ? b.topic.trim() : undefined,
    attendees: Array.isArray(b.attendees) ? b.attendees.filter((x): x is string => typeof x === 'string') : undefined,
    language,
    parts,
    includeInternal: b.includeInternal === true,
    glossary
  }
}

function buildPrompt(segments: TranscriptSegment[], req: DraftRequest): { system: string; user: string } {
  const langName = req.language === 'vi' ? 'Vietnamese' : 'English'
  const system = [
    'You draft a meeting note from a transcript. The note is evidence of what was agreed.',
    `Write every field in ${langName}. Keep English domain terms (rubric, competency, assessment report, scoring, prompt) in English. Quote people verbatim.`,
    'Every decision, action, question, request and number value MUST carry atMs = the start (the number in brackets) of the transcript line where it was said. If you cannot point at a line, set atMs to null — never estimate.',
    'A client request is not a decision. A decision is something both sides agreed.',
    'For numbers, list every value the transcript gives for the same quantity, each with its own atMs, even when they disagree. Do not reconcile them.',
    'Do not name the client or any company; names are supplied separately.',
    'Return JSON only.'
  ].join('\n')

  const glossary = req.glossary?.length
    ? 'Glossary (the transcript mis-hears these; use the term):\n' +
      req.glossary.map((e) => `- ${e.heard.join(', ')} → ${e.term}`).join('\n') +
      '\n\n'
    : ''
  const transcript = segments.map((s) => `[${s.startMs}] ${s.speaker}: ${s.text}`).join('\n')
  return { system, user: `${glossary}Transcript (Me = the note owner, Them = the other end):\n${transcript}` }
}

export interface NoteDraftOptions {
  artifactsDir: string
  id: string
  dataDir?: string
  fetchImpl?: typeof fetch
}

/**
 * POST /meetings/:id/note/draft — called from handleMeetingsRoute after the token
 * check, so the request is authenticated and artifactsDir is configured.
 */
export async function handleNoteDraft(
  req: IncomingMessage,
  res: ServerResponse,
  opts: NoteDraftOptions
): Promise<void> {
  const dir = path.join(opts.artifactsDir, MEETINGS_DIR, opts.id)
  if (!fs.existsSync(dir)) {
    sendJson(res, 404, { error: 'meeting not found' })
    return
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return
  }
  let body: unknown
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw.toString('utf8'))
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return
  }
  const draft = parseDraftRequest(body)
  if (typeof draft === 'string') {
    sendJson(res, 400, { error: draft })
    return
  }

  let segments: TranscriptSegment[]
  try {
    const t = JSON.parse(fs.readFileSync(path.join(dir, 'transcript.json'), 'utf8')) as {
      segments?: TranscriptSegment[]
    }
    segments = Array.isArray(t.segments) ? t.segments : []
  } catch {
    sendJson(res, 409, { error: 'not transcribed' })
    return
  }

  let cfg
  try {
    cfg = opts.dataDir ? resolveAzureConfig(opts.dataDir) : null
  } catch (err) {
    if (err instanceof AiError && err.kind === 'no_key') cfg = null
    else throw err
  }
  if (!cfg) {
    sendJson(res, 501, { error: 'no model configured' })
    return
  }

  const { system, user } = buildPrompt(segments, draft)
  let model: ModelNote | null = null
  // One retry on a parse failure only. Anything else — auth, rate limit, network —
  // will not be fixed by asking again a millisecond later.
  for (let attempt = 1; attempt <= 2 && model === null; attempt++) {
    try {
      model = await askAzureJson<ModelNote>({
        cfg,
        system,
        user,
        schema: NOTE_SCHEMA,
        schemaName: 'meeting_note',
        fetchImpl: opts.fetchImpl
      })
    } catch (err) {
      if (!(err instanceof AiError)) throw err
      if (err.kind === 'parse' && attempt === 1) continue
      // The adapter's own words: a provider body can reflect the key back.
      sendJson(res, 502, { error: 'note draft failed', kind: err.kind })
      return
    }
  }
  if (model === null) {
    sendJson(res, 502, { error: 'note draft failed', kind: 'parse' })
    return
  }

  const { note, dropped } = enforce(model, segments, draft)
  sendJson(res, 200, { note, markdown: renderMarkdown(note, segments, draft, opts.id), dropped })
}
