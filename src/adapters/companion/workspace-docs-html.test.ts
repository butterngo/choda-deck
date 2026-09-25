// TASK-1956 — a workspace .html is served as HTML, sandboxed.
//
// Two things are under test and they pull against each other. The route must
// answer text/html so a report RENDERS instead of being spelled out as source;
// and it must make that safe, because a workspace .html is arbitrary content
// that would otherwise execute on the adapter's own origin, beside its API.
//
// Every content-type assertion below is paired with a control of a different
// extension. A route that answered text/html for everything would satisfy each
// positive assertion on its own — the controls are what make the criterion able
// to fail.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleWorkspaceDocsRoute } from './workspace-docs'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'

const TOKEN = 'html-route-token'

interface Captured {
  status: number
  headers: Record<string, string>
  bytes: Buffer
}

/** Captures BYTES, not a string — AC-4 is a byte claim and a decode would erase it. */
function fakeRes(cap: Captured): ServerResponse {
  return {
    writeHead(status: number, headers?: Record<string, string>) {
      cap.status = status
      cap.headers = headers ?? {}
      return this
    },
    end(payload?: string | Buffer) {
      cap.bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8')
      return this
    }
  } as unknown as ServerResponse
}

function req(url: string, method = 'GET'): IncomingMessage {
  return { url, method, headers: { 'x-choda-bridge-token': TOKEN } } as unknown as IncomingMessage
}

let root: string
let svc: WorkspaceOperations

/** CRLF throughout AND a UTF-8 BOM — the two things a re-encoding server loses. */
const HTML_CRLF_BOM = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from(
    ['<!doctype html>', '<title>report</title>', '<h1>Rendered</h1>', '<p>body</p>', ''].join('\r\n'),
    'utf8'
  )
])

async function get(rel: string): Promise<Captured> {
  const cap = { status: 0, headers: {}, bytes: Buffer.alloc(0) } as Captured
  await handleWorkspaceDocsRoute(req(`/workspace-docs/main/${rel}`), fakeRes(cap), {
    svc,
    bridgeToken: TOKEN
  })
  return cap
}

const ctype = (c: Captured): string => c.headers['content-type'] ?? ''

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-html-'))
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'report.html'), HTML_CRLF_BOM)
  fs.writeFileSync(path.join(root, 'docs', 'legacy.htm'), '<h1>legacy</h1>')
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide')
  fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), 'plain text')
  fs.writeFileSync(path.join(root, 'docs', 'app.ts'), 'export const x = 1')
  // Not html, but ends in letters that a sloppy `includes` would match.
  fs.writeFileSync(path.join(root, 'docs', 'nothtml.ts'), 'export const y = 2')
  fs.writeFileSync(path.join(root, 'docs', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(root, 'docs', 'bundle.zip'), Buffer.from([0x50, 0x4b, 3, 4]))
  fs.writeFileSync(path.join(path.dirname(root), 'secret-outside.html'), '<h1>SECRET</h1>')
  svc = {
    getWorkspace: async (asked: string) =>
      asked === 'main' ? ({ id: 'main', label: 'Main', cwd: root, projectId: 'p1' } as never) : null
  } as unknown as WorkspaceOperations
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(path.join(path.dirname(root), 'secret-outside.html'), { force: true })
})

describe('TASK-1956 — .html served as HTML', () => {
  it('AC-1 — .html is text/html while .txt and .ts stay text/plain', async () => {
    const html = await get('docs/report.html')
    const txt = await get('docs/notes.txt')
    const ts = await get('docs/app.ts')
    const decoy = await get('docs/nothtml.ts')

    expect(html.status).toBe(200)
    expect(ctype(html)).toBe('text/html; charset=utf-8')

    // The controls. Without these, "always text/html" passes the line above.
    expect(ctype(txt)).toBe('text/plain; charset=utf-8')
    expect(ctype(ts)).toBe('text/plain; charset=utf-8')
    // A filename CONTAINING "html" is not an html file.
    expect(ctype(decoy)).toBe('text/plain; charset=utf-8')
  })

  it('AC-2 — the html response is sandboxed and un-sniffable', async () => {
    const html = await get('docs/report.html')
    expect(html.headers['content-security-policy']).toBe('sandbox')
    expect(html.headers['x-content-type-options']).toBe('nosniff')

    // `sandbox` with NO allow-* token is the whole point: an allow-same-origin
    // would hand the document back the adapter's origin, which is what this
    // header exists to deny.
    expect(html.headers['content-security-policy']).not.toMatch(/allow-/)
  })

  it('AC-3 — .md still text/markdown, and .htm counts as html', async () => {
    const md = await get('docs/guide.md')
    const htm = await get('docs/legacy.htm')
    expect(ctype(md)).toBe('text/markdown; charset=utf-8')
    // The legacy extension. A check written as endsWith('.html') passes every
    // other test in this file and fails only here.
    expect(ctype(htm)).toBe('text/html; charset=utf-8')
    expect(htm.headers['content-security-policy']).toBe('sandbox')
    // markdown is NOT sandboxed — it is not executed by anything.
    expect(md.headers['content-security-policy']).toBeUndefined()
  })

  it('AC-4 — the bytes and the etag are untouched by the new content-type', async () => {
    const onDisk = fs.readFileSync(path.join(root, 'docs', 'report.html'))
    const res = await get('docs/report.html')

    // Byte comparison, never string: a string compare cannot see a lost BOM.
    expect(Buffer.compare(res.bytes, onDisk)).toBe(0)
    expect([...res.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(res.bytes.includes(Buffer.from('\r\n'))).toBe(true)

    // The etag must still describe the file on disk — PUT's if-match
    // precondition (TASK-1935) is built on exactly that equality.
    const hash = createHash('sha256').update(onDisk).digest('hex')
    expect(res.headers.etag).toBe(hash)
  })

  it('AC-5 — the guards the route had before are still in front of this', async () => {
    // Traversal: an .html OUTSIDE the workspace must not become reachable just
    // because .html is now rendered.
    const escaped = await get('../secret-outside.html')
    expect(escaped.status).not.toBe(200)
    expect(escaped.bytes.toString('utf8')).not.toContain('SECRET')

    // A binary extension is still refused as a category error, not served.
    // (TASK-2142 made raster images the one exception, so this uses a .zip.)
    const zip = await get('docs/bundle.zip')
    expect(zip.status).toBe(415)
  })
})
