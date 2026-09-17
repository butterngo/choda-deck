// TASK-1991 — turn a finalized meeting's two tracks into transcript.json.
//
// The API, the input format and the limits all come from a run, not from
// documentation: TASK-1990 sent a real 25-minute bilingual client call through
// scripts/proof-speech.mjs, and the ADR
// `adr-meeting-transcription-azure-speech-fast-per-track-audio-leaves-the-laptop`
// records what came back. Three of its findings shape this file:
//
//   * Fast transcription accepts the recorder's WebM/Opus exactly as stored, so
//     nothing here transcodes and nothing new is installed.
//   * Each track is sent on its own. The track, not the model, says who spoke:
//     mic is Me, loopback is Them. A mixed file would throw that away for free.
//   * Azure's phrases are long — a median of ~28 s on that call — which is
//     useless for a ▶ that should land on the sentence being disputed. Every word
//     carries its own offset, so segments are rebuilt from word timings below.
//
// Transcription is re-runnable and never destructive. The audio is only read, and
// transcript.json is replaced only once BOTH tracks have come back parsed: Azure
// being down, a key expiring or a quota running out must never cost a recording
// or the last good transcript.

import * as fs from 'fs'
import * as path from 'path'
import type { ServerResponse } from 'http'
// Type-only: meetings.ts imports this module, so a value import back would be a cycle.
import type { MeetingMeta, Track } from './meetings'

const MEETINGS_DIR = 'meetings'

export const TRANSCRIPT_FILE = 'transcript.json'
export const FAST_API_VERSION = '2024-11-15'

/** A segment grows until a sentence ends or it reaches this length. */
export const SEGMENT_MAX_MS = 12_000

const SPEAKER: Record<Track, 'Me' | 'Them'> = { mic: 'Me', loopback: 'Them' }
const TRACK_ORDER: Track[] = ['mic', 'loopback']
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const SENTENCE_END = /[.?!…]["')\]]*$/

export interface TranscriptSegment {
  track: Track
  speaker: 'Me' | 'Them'
  startMs: number
  endMs: number
  text: string
  locale: string | null
}

export interface Transcript {
  meetingId: string
  engine: 'azure-speech'
  api: 'fast-transcription'
  createdAt: string
  segments: TranscriptSegment[]
}

export interface SpeechCredentials {
  key: string
  endpoint: string
  locales: string[]
}

interface AzureWord {
  text: string
  offsetMilliseconds: number
  durationMilliseconds: number
}

interface AzurePhrase {
  offsetMilliseconds: number
  durationMilliseconds: number
  text: string
  locale?: string
  words?: AzureWord[]
}

class TranscriptionError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Read `KEY=value` lines. Only the three fields this route needs are returned, and
 * a missing key or endpoint is `null` — the caller answers 501 rather than
 * guessing. Region is deliberately not read: the endpoint is the resource's custom
 * domain and addresses it on its own (checked 2026-09-17).
 */
export function readSpeechCredentials(file: string | undefined): SpeechCredentials | null {
  if (!file) return null
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const values: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const m = line.match(/^\s*([A-Za-z_-]+)\s*=\s*(.*?)\s*$/)
    if (m) values[m[1].toUpperCase()] = m[2]
  }
  const key = values.AZURE_SPEECH_KEY ?? ''
  const endpoint = (values.AZURE_SPEECH_ENDPOINT ?? '').replace(/\/+$/, '')
  if (!key || !endpoint) return null
  const locales = (values.AZURE_SPEECH_LOCALES || 'vi-VN,en-US')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return { key, endpoint, locales }
}

/**
 * Split one Azure phrase into seek-sized segments.
 *
 * Azure's `words[]` carry timings but no punctuation; the phrase `text` carries
 * punctuation but no timings. On the real call the phrase's whitespace tokens
 * lined up one-to-one with its words (38 of 38 phrases), so the two are zipped and
 * a token ending a sentence closes the segment. When they do not line up, the word
 * texts are used and only the length cap splits — a coarser answer, never a wrong
 * one.
 */
export function splitPhrase(phrase: AzurePhrase, track: Track): TranscriptSegment[] {
  const locale = phrase.locale ?? null
  const words = phrase.words ?? []
  const base = { track, speaker: SPEAKER[track], locale }
  if (words.length === 0) {
    return [
      {
        ...base,
        startMs: phrase.offsetMilliseconds,
        endMs: phrase.offsetMilliseconds + phrase.durationMilliseconds,
        text: phrase.text
      }
    ]
  }

  const tokens = phrase.text.split(/\s+/).filter(Boolean)
  const aligned = tokens.length === words.length
  const out: TranscriptSegment[] = []
  let current: { startMs: number; endMs: number; parts: string[] } | null = null

  words.forEach((word, i) => {
    const text = aligned ? tokens[i] : word.text
    const endMs = word.offsetMilliseconds + word.durationMilliseconds
    if (current === null) current = { startMs: word.offsetMilliseconds, endMs, parts: [] }
    current.parts.push(text)
    current.endMs = endMs
    const sentenceEnds = aligned && SENTENCE_END.test(text)
    const tooLong = current.endMs - current.startMs >= SEGMENT_MAX_MS
    if (sentenceEnds || tooLong || i === words.length - 1) {
      out.push({ ...base, startMs: current.startMs, endMs: current.endMs, text: current.parts.join(' ') })
      current = null
    }
  })
  return out
}

/** Merge both tracks by time. Ties put mic first so the order is stable. */
export function mergeSegments(byTrack: Partial<Record<Track, TranscriptSegment[]>>): TranscriptSegment[] {
  return TRACK_ORDER.flatMap((t) => byTrack[t] ?? []).sort(
    (a, b) => a.startMs - b.startMs || TRACK_ORDER.indexOf(a.track) - TRACK_ORDER.indexOf(b.track)
  )
}

/** Azure's "this audio holds no speech I can identify" — and nothing else. */
function isNoSpeech(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { code?: string; innerError?: { code?: string } }
    return parsed.innerError?.code === 'NoLanguageIdentified'
  } catch {
    return false
  }
}

async function transcribeTrack(
  audio: Buffer,
  track: Track,
  creds: SpeechCredentials
): Promise<TranscriptSegment[]> {
  const form = new FormData()
  form.append('audio', new Blob([new Uint8Array(audio)], { type: 'audio/webm' }), `${track}.webm`)
  form.append('definition', JSON.stringify({ locales: creds.locales }))

  let res: Response
  try {
    res = await fetch(
      `${creds.endpoint}/speechtotext/transcriptions:transcribe?api-version=${FAST_API_VERSION}`,
      { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': creds.key }, body: form }
    )
  } catch (err) {
    throw new TranscriptionError(`${track}: ${(err as Error).message}`)
  }
  const text = await res.text()
  // TASK-1999 — silence is an answer, not a failure. A track where nobody spoke
  // (a muted mic, a client who joined late) comes back as 422 NoLanguageIdentified.
  // Treating that as fatal threw away the OTHER track's speech with it, so a
  // meeting with one quiet side could not be transcribed at all. Only this one
  // code is downgraded: any other 422 is a real problem with the audio.
  if (res.status === 422 && isNoSpeech(text)) return []
  if (!res.ok) {
    // Azure's own error body can be long; keep it short and never echo the key.
    throw new TranscriptionError(`${track}: HTTP ${res.status} ${text.slice(0, 200).replaceAll(creds.key, '')}`)
  }
  let body: { phrases?: AzurePhrase[] }
  try {
    body = JSON.parse(text) as { phrases?: AzurePhrase[] }
  } catch {
    throw new TranscriptionError(`${track}: response is not JSON`)
  }
  if (!Array.isArray(body.phrases)) throw new TranscriptionError(`${track}: response has no phrases[]`)
  return body.phrases.flatMap((p) => splitPhrase(p, track))
}

/** When transcript.json was last written, or null. Read by GET /meetings. */
export function readTranscribedAt(artifactsDir: string, id: string): string | null {
  try {
    const t = JSON.parse(
      fs.readFileSync(path.join(artifactsDir, MEETINGS_DIR, id, TRANSCRIPT_FILE), 'utf8')
    ) as Partial<Transcript>
    return typeof t.createdAt === 'string' ? t.createdAt : null
  } catch {
    return null
  }
}

/**
 * POST /meetings/:id/transcribe
 *
 * Called from handleMeetingsRoute after the token check, so it assumes an
 * authenticated request and a configured artifactsDir.
 */
export async function handleTranscribe(
  res: ServerResponse,
  opts: { artifactsDir: string; id: string; speechCredentialsFile?: string }
): Promise<void> {
  const { artifactsDir, id } = opts
  const dir = path.join(artifactsDir, MEETINGS_DIR, id)
  if (!ID_RE.test(id) || !fs.existsSync(dir)) {
    sendJson(res, 404, { error: 'meeting not found' })
    return
  }
  let meta: MeetingMeta | null = null
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as MeetingMeta
  } catch {
    meta = null
  }
  if (!meta) {
    // Still recording, or cut short and not yet recovered. Transcribing half a
    // meeting would store a transcript that silently misses its end.
    sendJson(res, 409, { error: 'meeting not finalized' })
    return
  }
  const creds = readSpeechCredentials(opts.speechCredentialsFile)
  if (!creds) {
    sendJson(res, 501, { error: 'speech not configured' })
    return
  }

  const tracks = meta.tracks.filter((t) => fs.existsSync(path.join(dir, `${t}.webm`)))
  let byTrack: Partial<Record<Track, TranscriptSegment[]>>
  try {
    // The two tracks are independent requests; a 25-minute meeting takes ~45 s
    // per track, so running them in parallel halves the wait.
    const results = await Promise.all(
      tracks.map(async (t) => [t, await transcribeTrack(fs.readFileSync(path.join(dir, `${t}.webm`)), t, creds)] as const)
    )
    byTrack = Object.fromEntries(results)
  } catch (err) {
    if (err instanceof TranscriptionError) {
      sendJson(res, 502, { error: 'transcription failed', detail: err.message })
      return
    }
    throw err
  }

  const transcript: Transcript = {
    meetingId: id,
    engine: 'azure-speech',
    api: 'fast-transcription',
    createdAt: new Date().toISOString(),
    segments: mergeSegments(byTrack)
  }
  // Temp + rename: a crash mid-write must not leave half a JSON file where the
  // previous good transcript used to be.
  const target = path.join(dir, TRANSCRIPT_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(transcript, null, 2), 'utf8')
  fs.renameSync(tmp, target)
  sendJson(res, 200, transcript)
}

/** Default credentials location: the repo-root sensitive_information/ beside dataDir. */
export function defaultSpeechCredentialsFile(dataDir: string | undefined): string | undefined {
  if (process.env.CHODA_SPEECH_CREDENTIALS_FILE) return process.env.CHODA_SPEECH_CREDENTIALS_FILE
  if (!dataDir) return undefined
  return path.join(dataDir, '..', 'sensitive_information', 'azure-speech.txt')
}

