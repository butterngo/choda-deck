#!/usr/bin/env node
// TASK-1990 — proof that Azure Speech transcribes one track of a real meeting
// recorded by the companion, with offsets precise enough for a ▶ seek.
//
// Lives in the repo, not C:\tmp: ADR-006's proof was lost that way and
// TASK-1964 had to rebuild it from scratch.
//
// Usage:
//   node scripts/proof-speech.mjs <meetingId> [--track mic|loopback]
//        [--phrase "banana seventeen"] [--expect-at mm:ss] [--tolerance-ms 2000]
//        [--json out.json]
//
// Exit codes — the discriminator is the point:
//   0  the phrase is in THIS track's transcript (and within tolerance, if --expect-at)
//   1  the phrase is absent — run against the other track this MUST be the answer,
//      otherwise the match is not track-specific and proves nothing
//   2  the phrase was found but its offset is outside the tolerance
//   3  a phrase came back without numeric offset/duration
//   4  usage / configuration / Azure error
//
// Credentials: read from sensitive_information/azure-speech.txt. A worktree does
// not carry that git-ignored folder, so CHODA_SPEECH_CREDENTIALS may point at the
// main checkout's copy. No value from the file is ever printed.

import fs from 'node:fs'
import path from 'node:path'

const FAST_API = 'fast-transcription'
const FAST_API_VERSION = '2024-11-15'

function fail(code, msg) {
  console.error(`proof-speech: ${msg}`)
  process.exit(code)
}

function parseArgs(argv) {
  const out = { track: 'mic', phrase: 'banana seventeen', toleranceMs: 2000 }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) fail(4, `${a} needs a value`)
      return argv[++i]
    }
    if (a === '--track') out.track = next()
    else if (a === '--phrase') out.phrase = next()
    else if (a === '--expect-at') out.expectAt = next()
    else if (a === '--tolerance-ms') out.toleranceMs = Number(next())
    else if (a === '--json') out.json = next()
    else if (a === '--artifacts-dir') out.artifactsDir = next()
    else rest.push(a)
  }
  if (rest.length !== 1) fail(4, 'expected exactly one <meetingId>')
  if (!['mic', 'loopback'].includes(out.track)) fail(4, `--track must be mic or loopback, got ${out.track}`)
  out.meetingId = rest[0]
  return out
}

function mmssToMs(s) {
  const parts = s.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) fail(4, `--expect-at must be mm:ss or h:mm:ss, got ${s}`)
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000
}

function readCredentials(repoRoot) {
  const file =
    process.env.CHODA_SPEECH_CREDENTIALS ?? path.join(repoRoot, 'sensitive_information', 'azure-speech.txt')
  if (!fs.existsSync(file)) fail(4, `credentials file not found: ${file}`)
  const values = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_-]+)\s*=\s*(.*?)\s*$/)
    if (m && !line.trimStart().startsWith('#')) values[m[1].toUpperCase()] = m[2]
  }
  const key = values.AZURE_SPEECH_KEY
  const endpoint = values.AZURE_SPEECH_ENDPOINT?.replace(/\/+$/, '')
  const locales = (values.AZURE_SPEECH_LOCALES || 'vi-VN,en-US').split(',').map((s) => s.trim()).filter(Boolean)
  // Region is deliberately optional: the endpoint is the resource's custom
  // domain and addresses it on its own (checked 2026-09-17).
  if (!key) fail(4, 'AZURE_SPEECH_KEY is empty')
  if (!endpoint) fail(4, 'AZURE_SPEECH_ENDPOINT is empty')
  return { key, endpoint, locales, file }
}

function normalize(s) {
  return s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const artifactsDir =
    args.artifactsDir ?? process.env.CHODA_ARTIFACTS_DIR ?? path.join(repoRoot, 'data', 'artifacts')
  const meetingDir = path.join(artifactsDir, 'meetings', args.meetingId)
  const audioPath = path.join(meetingDir, `${args.track}.webm`)
  if (!fs.existsSync(audioPath)) fail(4, `no audio at ${audioPath}`)

  const creds = readCredentials(repoRoot)
  const audio = fs.readFileSync(audioPath)

  const form = new FormData()
  // Sent as stored: the companion's WebM/Opus bytes, no transcoding. If Azure
  // refuses the container this is where it will say so.
  form.append('audio', new Blob([audio], { type: 'audio/webm' }), `${args.track}.webm`)
  form.append('definition', JSON.stringify({ locales: creds.locales }))

  const url = `${creds.endpoint}/speechtotext/transcriptions:transcribe?api-version=${FAST_API_VERSION}`
  const started = Date.now()
  const res = await fetch(url, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': creds.key }, body: form })
  const elapsedMs = Date.now() - started
  const text = await res.text()

  console.log(`api:        ${FAST_API} (api-version ${FAST_API_VERSION})`)
  console.log(`input:      ${args.track}.webm sent as stored (audio/webm, ${audio.length} bytes, not transcoded)`)
  console.log(`locales:    ${creds.locales.join(',')}`)
  console.log(`http:       ${res.status} in ${elapsedMs} ms`)

  if (!res.ok) fail(4, `Azure answered ${res.status}: ${text.slice(0, 400).replaceAll(creds.key, '<key>')}`)

  let body
  try {
    body = JSON.parse(text)
  } catch {
    fail(4, 'Azure answered 2xx with a body that is not JSON')
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(body, null, 2))

  const phrases = (body.phrases ?? []).map((p) => ({
    offsetMs: p.offsetMilliseconds,
    durationMs: p.durationMilliseconds,
    locale: p.locale ?? null,
    text: p.text,
    words: (p.words ?? []).map((w) => ({ text: w.text, offsetMs: w.offsetMilliseconds })),
  }))
  console.log(`duration:   ${body.durationMilliseconds} ms · ${phrases.length} phrases`)
  console.log('')
  for (const p of phrases) {
    const at = new Date(p.offsetMs ?? 0).toISOString().slice(14, 22)
    console.log(`  [${at}] +${p.durationMs}ms ${p.locale ?? '-'}  ${p.text}`)
  }
  console.log('')

  const untimed = phrases.filter((p) => !Number.isFinite(p.offsetMs) || !Number.isFinite(p.durationMs))
  if (untimed.length) fail(3, `${untimed.length} phrase(s) lack numeric offsetMs/durationMs`)

  const needle = normalize(args.phrase)
  const hit = phrases.find((p) => normalize(p.text).includes(needle))
  if (!hit) {
    console.log(`result:     "${args.phrase}" NOT in the ${args.track} track`)
    process.exit(1)
  }
  console.log(`result:     "${args.phrase}" found in the ${args.track} track at offsetMs=${hit.offsetMs}`)

  if (args.expectAt) {
    // Measured from the planted phrase's FIRST WORD when Azure returns word
    // timings, because a long Azure phrase can start well before the planted
    // words. Falls back to the phrase start, and says which one it used.
    const expected = mmssToMs(args.expectAt)
    const first = needle.split(' ')[0]
    const word = (hit.words ?? []).find((w) => normalize(w.text) === first)
    const anchorMs = word ? word.offsetMs : hit.offsetMs
    const delta = expected - anchorMs
    console.log(`expect-at:  ${args.expectAt} (${expected} ms) · anchor ${word ? `word "${word.text}"` : 'phrase start'} at ${anchorMs} ms · delta ${delta} ms`)
    if (Math.abs(delta) > args.toleranceMs) {
      console.log(`result:     offset OUTSIDE ±${args.toleranceMs} ms`)
      process.exit(2)
    }
    console.log(`result:     offset within ±${args.toleranceMs} ms`)
  }
  process.exit(0)
}

main().catch((err) => fail(4, err?.message ?? String(err)))
