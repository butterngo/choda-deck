// TASK-1332 — helpers for the rich capture kinds: decode + persist a screenshot
// to the artifacts dir, and format a network record (headers/cookies, NEVER the
// response body) into markdown for the target entry.

import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { CaptureBadRequestError } from './capture-contract'

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export interface StoredArtifact {
  filePath: string
  // TASK-1566/1567 — the same file expressed relative to the artifacts root, in
  // forward slashes (e.g. `captures/ab12.png`). This is what goes into an entry
  // body: an absolute `C:\...` path is unresolvable from the companion's http
  // origin and non-portable across machines. `GET /artifacts/<relPath>` serves it.
  // Mirrors what writeDiscoverySession already returns as `relDir`.
  relPath: string
  bytes: number
}

// Every capture artifact lives under `<artifactsDir>/captures/`. Centralized so
// the three writers cannot drift on the prefix the route depends on.
const CAPTURES_DIR = 'captures'

function relFrom(fileName: string): string {
  return `${CAPTURES_DIR}/${fileName}`
}

/**
 * Decode a base64 image data URL and write it under `<artifactsDir>/captures/`.
 * Returns the absolute path the target entry references. Throws
 * CaptureBadRequestError (→400) on a malformed/unsupported data URL.
 */
export function writeImageArtifact(artifactsDir: string, dataUrl: unknown): StoredArtifact {
  if (typeof dataUrl !== 'string') {
    throw new CaptureBadRequestError('image payload requires a base64 data-URL string')
  }
  const match = DATA_URL_RE.exec(dataUrl)
  if (!match) {
    throw new CaptureBadRequestError('image payload must be a data:image/*;base64 URL')
  }
  const [, mime, b64] = match
  const ext = MIME_EXT[mime.toLowerCase()]
  if (!ext) throw new CaptureBadRequestError(`unsupported image mime: ${mime}`)
  const buf = Buffer.from(b64, 'base64')
  if (buf.length === 0) throw new CaptureBadRequestError('image payload decoded to zero bytes')

  const dir = path.join(artifactsDir, CAPTURES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${randomBytes(8).toString('hex')}.${ext}`
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, buf)
  return { filePath, relPath: relFrom(name), bytes: buf.length }
}

export interface NetworkRecord {
  method: string
  url: string
  status?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  cookies?: Record<string, string>
  // Response body, captured client-side by the extension's page interceptor
  // (webRequest can't see it). Optional + capped by the caller.
  body?: string
  // Request body, same interceptor, same reason. Only string bodies
  // are captured — a FormData / Blob post legitimately arrives without one.
  reqBody?: string
}

// Defensive cap so a large body can't bloat the stored entry (the extension caps
// too, but the contract shouldn't trust the client).
const MAX_BODY_CHARS = 64 * 1024

function isStringMap(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  )
}

/** Narrow an arbitrary payload.record into a NetworkRecord, or throw 400. */
export function parseNetworkRecord(record: unknown): NetworkRecord {
  if (typeof record !== 'object' || record === null) {
    throw new CaptureBadRequestError('network payload requires a "record" object')
  }
  const r = record as Record<string, unknown>
  if (typeof r.method !== 'string' || typeof r.url !== 'string') {
    throw new CaptureBadRequestError('network record requires string "method" and "url"')
  }
  const out: NetworkRecord = { method: r.method, url: r.url }
  if (typeof r.status === 'number') out.status = r.status
  if (r.requestHeaders !== undefined && isStringMap(r.requestHeaders)) {
    out.requestHeaders = r.requestHeaders
  }
  if (r.responseHeaders !== undefined && isStringMap(r.responseHeaders)) {
    out.responseHeaders = r.responseHeaders
  }
  if (r.cookies !== undefined && isStringMap(r.cookies)) out.cookies = r.cookies
  if (typeof r.body === 'string' && r.body.length > 0) out.body = r.body.slice(0, MAX_BODY_CHARS)
  if (typeof r.reqBody === 'string' && r.reqBody.length > 0) {
    out.reqBody = r.reqBody.slice(0, MAX_BODY_CHARS)
  }
  return out
}

// ---- HAR bundle (TASK-1372) -------------------------------------------------
// A selection of network records serialized as ONE lean HAR 1.2 file, so the
// conversation links a single artifact that opens in DevTools / any HAR viewer.

interface HarNameValue {
  name: string
  value: string
}

function harHeaders(headers?: Record<string, string>): HarNameValue[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
}

function harEntry(record: NetworkRecord, startedDateTime: string): Record<string, unknown> {
  return {
    startedDateTime,
    time: -1,
    request: {
      method: record.method,
      url: record.url,
      httpVersion: 'HTTP/1.1',
      headers: harHeaders(record.requestHeaders),
      queryString: [],
      cookies: harHeaders(record.cookies),
      headersSize: -1,
      bodySize: record.reqBody ? record.reqBody.length : -1,
      ...(record.reqBody
        ? {
            postData: {
              mimeType: record.requestHeaders?.['content-type'] ?? 'x-unknown',
              text: record.reqBody
            }
          }
        : {})
    },
    response: {
      status: record.status ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: harHeaders(record.responseHeaders),
      cookies: [],
      content: {
        size: record.body ? record.body.length : 0,
        mimeType: record.responseHeaders?.['content-type'] ?? 'x-unknown',
        ...(record.body ? { text: record.body } : {})
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1
    },
    cache: {},
    timings: { send: -1, wait: -1, receive: -1 }
  }
}

/** Serialize records into a lean HAR 1.2 log (spec-minimal fields, -1 unknowns). */
export function buildHar(records: NetworkRecord[]): string {
  const startedDateTime = new Date().toISOString()
  return JSON.stringify(
    {
      log: {
        version: '1.2',
        creator: { name: 'choda-capture', version: '1.0' },
        entries: records.map((r) => harEntry(r, startedDateTime))
      }
    },
    null,
    2
  )
}

/**
 * Write a design-token set as JSON under `<artifactsDir>/captures/` (TASK-1554).
 *
 * The tokens go to disk rather than inline into the knowledge entry: a full palette +
 * type scale + spacing set for a real page is far larger than a readable entry body,
 * and the entry only needs to reference it. Same reasoning as the HAR bundle above.
 */
export function writeDesignTokensArtifact(artifactsDir: string, tokens: unknown): StoredArtifact {
  if (typeof tokens !== 'object' || tokens === null) {
    throw new CaptureBadRequestError('design payload requires a "tokens" object')
  }
  const json = JSON.stringify(tokens, null, 2)
  const dir = path.join(artifactsDir, CAPTURES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${randomBytes(8).toString('hex')}.design.json`
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, json, 'utf8')
  return { filePath, relPath: relFrom(name), bytes: Buffer.byteLength(json) }
}

/** Write a HAR bundle under `<artifactsDir>/captures/` and return its path. */
export function writeHarArtifact(artifactsDir: string, records: NetworkRecord[]): StoredArtifact {
  const har = buildHar(records)
  const dir = path.join(artifactsDir, CAPTURES_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${randomBytes(8).toString('hex')}.har`
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, har, 'utf8')
  return { filePath, relPath: relFrom(name), bytes: Buffer.byteLength(har) }
}

function headerBlock(title: string, headers?: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return ''
  const rows = Object.entries(headers)
    .map(([k, v]) => `- \`${k}\`: ${v}`)
    .join('\n')
  return `\n**${title}**\n${rows}\n`
}

/**
 * Render a network capture as markdown — method/url/status + headers + cookies,
 * plus request/response bodies when the page interceptor captured them. Secrets
 * in the headers/cookies/bodies stay local-only (image/network can't target the
 * sync path).
 */
export function formatNetworkRecord(record: NetworkRecord): string {
  const status = record.status !== undefined ? ` → ${record.status}` : ''
  const body = record.body ? `\n**Response body**\n\`\`\`\n${record.body}\n\`\`\`\n` : ''
  const payload = record.reqBody ? `\n**Request body**\n\`\`\`\n${record.reqBody}\n\`\`\`\n` : ''
  return (
    `**${record.method} ${record.url}**${status}\n` +
    headerBlock('Request headers', record.requestHeaders) +
    payload +
    headerBlock('Response headers', record.responseHeaders) +
    headerBlock('Cookies', record.cookies) +
    body
  )
}
