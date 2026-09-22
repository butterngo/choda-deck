// A track whose Azure answer fails the plausibility guard is re-sent, because the
// corruption is transient: on 2026-09-22 meeting m-muc1vdsp-npyokc failed the guard
// in the app and came back clean when the same audio was sent again.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findImplausibleSegments, transcribeTrackWithRetry } from './meeting-transcribe'

const creds = { key: 'k', endpoint: 'https://example.invalid', locales: ['vi-VN'] }
const BROKEN = JSON.stringify({ phrases: [{ offsetMilliseconds: 767500, durationMilliseconds: 10, text: 'x'.repeat(299) }] })
const CLEAN = JSON.stringify({ phrases: [{ offsetMilliseconds: 44000, durationMilliseconds: 6000, text: 'một câu bình thường' }] })

function fakeAzure(bodies: string[]) {
  const calls = { n: 0 }
  const fetchFn = async () => new Response(bodies[Math.min(calls.n++, bodies.length - 1)], { status: 200 })
  return { calls, fetchFn }
}

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('transcribeTrackWithRetry', () => {
  it('re-sends a track whose first answer is implausible and keeps the clean one', async () => {
    const { calls, fetchFn } = fakeAzure([BROKEN, CLEAN])
    const segs = await transcribeTrackWithRetry(Buffer.from('a'), 'mic', creds, { dir, fetchFn })
    expect(calls.n).toBe(2)
    expect(findImplausibleSegments(segs)).toHaveLength(0)
    expect(segs[0].startMs).toBe(44000)
  })

  it('keeps each rejected response on disk as evidence', async () => {
    const { fetchFn } = fakeAzure([BROKEN, CLEAN])
    await transcribeTrackWithRetry(Buffer.from('a'), 'mic', creds, { dir, fetchFn })
    expect(fs.readFileSync(path.join(dir, 'rejected-mic-1.json'), 'utf8')).toBe(BROKEN)
  })

  it('sends a clean track exactly once', async () => {
    const { calls, fetchFn } = fakeAzure([CLEAN])
    await transcribeTrackWithRetry(Buffer.from('a'), 'loopback', creds, { dir, fetchFn })
    expect(calls.n).toBe(1)
    expect(fs.readdirSync(dir)).toHaveLength(0)
  })

  it('gives up after the attempt limit and hands back the broken segments for the guard to refuse', async () => {
    const { calls, fetchFn } = fakeAzure([BROKEN])
    const segs = await transcribeTrackWithRetry(Buffer.from('a'), 'mic', creds, { dir, fetchFn, attempts: 3 })
    expect(calls.n).toBe(3)
    expect(findImplausibleSegments(segs)).toHaveLength(1)
  })
})
