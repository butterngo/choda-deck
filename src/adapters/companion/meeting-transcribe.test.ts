// TASK-1991 — POST /meetings/:id/transcribe. One test per acceptance criterion,
// driven over a real companion server with a real HTTP stub standing in for
// Azure, because the contract is status codes, files on disk and what was (or was
// not) sent upstream.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'http'
import { createHash } from 'crypto'
import type { AddressInfo } from 'net'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { MEETINGS_DIR } from './meetings'

const TOKEN = 'transcribe-test-token'
const KEY = 'stub-speech-key-0123456789abcdef'

let dataDir: string
let artifactsDir: string
let credsFile: string
let handle: CompanionServerHandle
let base: string

// ---- Azure stub -----------------------------------------------------------------

interface StubPhrase {
  offsetMilliseconds: number
  durationMilliseconds: number
  text: string
  locale?: string
  words?: Array<{ text: string; offsetMilliseconds: number; durationMilliseconds: number }>
}

let azure: http.Server
let azureUrl: string
let azureCalls: Array<{ track: string; key: string | undefined }> = []
/** What the stub answers, per track. A number is an HTTP error status. */
let azureReply: Record<string, StubPhrase[] | number> = {}

function phrase(offset: number, text: string, duration = 1000): StubPhrase {
  return { offsetMilliseconds: offset, durationMilliseconds: duration, text, locale: 'vi-VN' }
}

beforeAll(async () => {
  azure = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      const track = /filename="(mic|loopback)\.webm"/.exec(body)?.[1] ?? '?'
      azureCalls.push({ track, key: req.headers['ocp-apim-subscription-key'] as string | undefined })
      const reply = azureReply[track]
      if (typeof reply === 'number' || reply === undefined) {
        res.writeHead(typeof reply === 'number' ? reply : 500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 'StubFailure' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ durationMilliseconds: 60000, phrases: reply }))
    })
  })
  await new Promise<void>((r) => azure.listen(0, '127.0.0.1', r))
  azureUrl = `http://127.0.0.1:${(azure.address() as AddressInfo).port}`

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-transcribe-'))
  artifactsDir = path.join(dataDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  credsFile = path.join(dataDir, 'azure-speech.txt')

  const services = {
    svc: {
      listProjects: async () => [],
      findTasks: async () => [],
      findInbox: async () => [],
      findConversations: async () => [],
      findWorkspaces: async () => []
    } as unknown as BackendTaskService,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    artifactsDir,
    speechCredentialsFile: credsFile,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle.close()
  await new Promise<void>((r) => azure.close(() => r()))
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir */
  }
})

beforeEach(() => {
  fs.rmSync(path.join(artifactsDir, MEETINGS_DIR), { recursive: true, force: true })
  azureCalls = []
  azureReply = {}
  writeCreds(KEY)
})

// ---- helpers --------------------------------------------------------------------

function writeCreds(key: string): void {
  fs.writeFileSync(
    credsFile,
    [
      '# test credentials',
      `AZURE_SPEECH_KEY=${key}`,
      'AZURE_SPEECH_REGION=',
      `AZURE_SPEECH_ENDPOINT=${azureUrl}/`,
      'AZURE_SPEECH_LOCALES=vi-VN,en-US'
    ].join('\n'),
    'utf8'
  )
}

function meetingDir(id: string): string {
  return path.join(artifactsDir, MEETINGS_DIR, id)
}

function seedMeeting(id: string, opts: { finalized?: boolean } = {}): void {
  const dir = meetingDir(id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'mic.webm'), Buffer.from('fake-mic-audio'))
  fs.writeFileSync(path.join(dir, 'loopback.webm'), Buffer.from('fake-loopback-audio'))
  if (opts.finalized !== false) {
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        id,
        startedAt: '2026-09-17T07:00:00.000Z',
        endedAt: '2026-09-17T07:10:00.000Z',
        tracks: ['mic', 'loopback'],
        bytes: 33
      }),
      'utf8'
    )
  }
}

function sha(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function transcribe(id: string): Promise<{ status: number; json: Record<string, unknown>; raw: string }> {
  const r = await fetch(`${base}/meetings/${id}/transcribe`, {
    method: 'POST',
    headers: { 'x-choda-bridge-token': TOKEN }
  })
  const raw = await r.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(raw) as Record<string, unknown>
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json, raw }
}

interface Seg {
  track: string
  speaker: string
  startMs: number
  text: string
}

function transcriptOnDisk(id: string): { createdAt: string; segments: Seg[] } {
  return JSON.parse(fs.readFileSync(path.join(meetingDir(id), 'transcript.json'), 'utf8')) as {
    createdAt: string
    segments: Seg[]
  }
}

// ---- acceptance -----------------------------------------------------------------

describe('AC-1 — both tracks merge by time, speaker from the track', () => {
  it('orders mic@1000, loopback@3000, mic@5000', async () => {
    seedMeeting('m1')
    azureReply = {
      mic: [phrase(1000, 'Một.'), phrase(5000, 'Ba.')],
      loopback: [phrase(3000, 'Hai.')]
    }
    const r = await transcribe('m1')
    expect(r.status).toBe(200)
    const segs = transcriptOnDisk('m1').segments
    expect(segs.map((s) => [s.track, s.startMs, s.speaker])).toEqual([
      ['mic', 1000, 'Me'],
      ['loopback', 3000, 'Them'],
      ['mic', 5000, 'Me']
    ])
    expect(azureCalls.map((c) => c.track).sort()).toEqual(['loopback', 'mic'])
    expect(azureCalls.every((c) => c.key === KEY)).toBe(true)
  })
})

describe('AC-2 — a long phrase is split at sentence ends using word timings', () => {
  it('"Một hai. Ba bốn năm." becomes segments at 0 and 20000 ms', async () => {
    seedMeeting('m2')
    azureReply = {
      mic: [
        {
          offsetMilliseconds: 0,
          durationMilliseconds: 30000,
          text: 'Một hai. Ba bốn năm.',
          locale: 'vi-VN',
          // Words as Azure returns them: timings, no punctuation.
          words: [
            { text: 'Một', offsetMilliseconds: 0, durationMilliseconds: 500 },
            { text: 'hai', offsetMilliseconds: 1000, durationMilliseconds: 500 },
            { text: 'Ba', offsetMilliseconds: 20000, durationMilliseconds: 500 },
            { text: 'bốn', offsetMilliseconds: 21000, durationMilliseconds: 500 },
            { text: 'năm', offsetMilliseconds: 22000, durationMilliseconds: 500 }
          ]
        }
      ],
      loopback: []
    }
    const r = await transcribe('m2')
    expect(r.status).toBe(200)
    const segs = transcriptOnDisk('m2').segments
    expect(segs.map((s) => s.startMs)).toEqual([0, 20000])
    expect(segs.map((s) => s.text)).toEqual(['Một hai.', 'Ba bốn năm.'])
  })
})

describe('AC-3 — unknown meeting', () => {
  it('404s and never calls Azure', async () => {
    const r = await transcribe('m404')
    expect(r.status).toBe(404)
    expect(azureCalls).toHaveLength(0)
  })
})

describe('AC-4 — meeting not finalized', () => {
  it('409s and never calls Azure', async () => {
    seedMeeting('m4', { finalized: false })
    const r = await transcribe('m4')
    expect(r.status).toBe(409)
    expect(r.json).toEqual({ error: 'meeting not finalized' })
    expect(azureCalls).toHaveLength(0)
  })
})

describe('AC-5 — speech not configured', () => {
  it('501s with no credential value in the body', async () => {
    seedMeeting('m5')
    writeCreds('')
    const r = await transcribe('m5')
    expect(r.status).toBe(501)
    expect(r.json).toEqual({ error: 'speech not configured' })
    expect(r.raw).not.toContain(azureUrl)
    expect(r.raw).not.toContain('127.0.0.1')
    expect(azureCalls).toHaveLength(0)
  })
})

describe('AC-6 — Azure failure changes nothing on disk', () => {
  it('502s and audio + previous transcript keep their sha256', async () => {
    seedMeeting('m6')
    azureReply = { mic: [phrase(1000, 'Trước.')], loopback: [] }
    expect((await transcribe('m6')).status).toBe(200)
    const files = ['mic.webm', 'loopback.webm', 'transcript.json'].map((f) => path.join(meetingDir('m6'), f))
    const before = files.map(sha)

    azureReply = { mic: 500, loopback: 500 }
    const r = await transcribe('m6')
    expect(r.status).toBe(502)
    expect(r.json.error).toBe('transcription failed')
    expect(r.raw).not.toContain(KEY)
    expect(files.map(sha)).toEqual(before)
  })
})

describe('AC-7 — re-running replaces the transcript', () => {
  it('writes the new text and moves transcribedAt forward', async () => {
    seedMeeting('m7')
    azureReply = { mic: [phrase(1000, 'Lần một.')], loopback: [] }
    expect((await transcribe('m7')).status).toBe(200)
    const first = transcriptOnDisk('m7').createdAt

    await new Promise((r) => setTimeout(r, 15))
    azureReply = { mic: [phrase(1000, 'Lần hai.')], loopback: [] }
    expect((await transcribe('m7')).status).toBe(200)
    expect(transcriptOnDisk('m7').segments.map((s) => s.text)).toEqual(['Lần hai.'])

    const list = (await (
      await fetch(`${base}/meetings`, { headers: { 'x-choda-bridge-token': TOKEN } })
    ).json()) as Array<{ id: string; transcribedAt: string | null }>
    const row = list.find((m) => m.id === 'm7')
    expect(row?.transcribedAt).toBeTruthy()
    expect(Date.parse(row!.transcribedAt!)).toBeGreaterThan(Date.parse(first))
  })
})
