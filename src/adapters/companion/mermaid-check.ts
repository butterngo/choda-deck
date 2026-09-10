// TASK-1934 — is this mermaid diagram syntactically valid, and where are the
// fences in a markdown file?
//
// Why this exists: on 2026-09-10, two of the twelve mermaid fences in
// ABCV2's docs/knowledge did not parse — an HTML entity `&gt;` that mermaid
// decodes back into an arrow, and an unquoted `{{` in a node label. Both had
// shipped inside ADRs and survived until a human happened to open the file.
// Nothing anywhere checks a fence: `mermaid` was a web dependency only, in no
// script and in neither CI workflow. This module is that missing check.
//
// PARSE IS NOT RENDER, and the response shape says so deliberately. Measured on
// node 24 / mermaid 11.17.0: `mermaid.parse` answers without a browser, while
// `mermaid.render` throws `document is not defined`. So `ok: true` means the
// grammar accepted the text — never that a browser will draw it. A caller who
// reads it as a rendering guarantee has been misled by us, so the guarantee is
// stated here rather than implied.
//
// "Without a browser" is not the same as "without a DOM" — see ensureDom below,
// which is the correction this file had to make to its own premise.
//
// The import is DYNAMIC. mermaid unpacks to 80 MB and the adapter bundle is
// small; esbuild still inlines it, but keeping the import inside the function
// means a process that never validates a diagram never evaluates the module.

import type { IncomingMessage, ServerResponse } from 'http'
import { Buffer } from 'buffer'
import { timingSafeEqual } from 'crypto'

/** Exact match, never a prefix — see the registration note in http-server.ts. */
const CHECK_ROUTE = '/workspace-docs/diagram/check'

/** Same 2 MB ceiling the other body-reading routes use. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * One ```mermaid fence, with the line span of its BODY.
 *
 * `start`/`end` are 1-based and EXCLUDE the ``` marker lines, so
 * `lines.slice(start - 1, end)` is exactly the code and a replacement can
 * rewrite those lines without touching the fence markers.
 *
 * `index` is the fence's position among mermaid fences in this file — 0 for the
 * first. That is what a client sends back as `fenceIndex`, and it is only a safe
 * identity when the save carries the hash of the same text (TASK-1935's
 * if-match); on its own an index means nothing.
 */
export interface MermaidFence {
  index: number
  code: string
  start: number
  end: number
}

/**
 * Every ```mermaid fence in a markdown document, in source order.
 *
 * CRLF is handled explicitly rather than by hoping. A regex written as
 * /```mermaid\n/ finds nothing in a CRLF file — which is not a hypothetical:
 * that exact mistake made an earlier sweep of these documents report "no
 * fences" for two files that had five between them, and the sweep looked like
 * a clean pass.
 */
export function listMermaidFences(markdown: string): MermaidFence[] {
  // Split only. The lines keep their trailing \r, because `code` has to be the
  // VERBATIM slice of the document: a caller that replaces a fence with a
  // normalised copy of itself silently converts that fence to LF, and `git diff`
  // then reports every line of it as changed. That is the same defect TASK-1935
  // exists to prevent, arriving through the reader instead of the writer.
  const lines = markdown.split('\n')
  const fences: MermaidFence[] = []
  let i = 0
  while (i < lines.length) {
    if (/^\s*```mermaid\s*\r?$/.test(lines[i] ?? '')) {
      const bodyStart = i + 2 // 1-based, first line after the opening marker
      let j = i + 1
      while (j < lines.length && !/^\s*```\s*\r?$/.test(lines[j] ?? '')) j += 1
      // An unterminated fence runs to EOF. Reporting it as a fence is the
      // honest reading — the document is malformed, and dropping it silently
      // would make the count disagree with what a reader sees.
      const bodyEnd = j // 1-based, last line before the closing marker
      fences.push({
        index: fences.length,
        code: lines.slice(bodyStart - 1, bodyEnd).join('\n'),
        start: bodyStart,
        end: bodyEnd
      })
      i = j + 1
      continue
    }
    i += 1
  }
  return fences
}

export type MermaidCheck = { ok: true } | { ok: false; error: string; line: number | null }

/** `Parse error on line 27:` → 27. Null when the message names no line. */
function lineFromParseError(message: string): number | null {
  const m = /on line (\d+)/i.exec(message)
  if (!m) return null
  const n = Number.parseInt(m[1] ?? '', 10)
  return Number.isFinite(n) ? n : null
}

/**
 * mermaid needs a DOM to parse SOME diagram types, and finding out which cost a
 * red control.
 *
 * TASK-1931's discovery measured `mermaid.parse` in node and recorded "runs in
 * plain node with no DOM". That is true for `sequenceDiagram` and false for
 * `flowchart`: flowchart labels are sanitised through DOMPurify, which without a
 * window is a factory rather than an instance, so mermaid dies on
 * `DOMPurify.addHook is not a function`. The original measurement was taken
 * under vitest's jsdom environment in the web package and never saw it.
 *
 * The reason this matters more than a missing dependency: the failure arrives as
 * a REJECTION. A broken flowchart and a working one both come back `ok: false`,
 * so the checker looks like it is doing its job while answering the same for
 * every input — the exact "criterion that cannot fail" this task was written to
 * prevent. Only the paired control caught it.
 *
 * Installed once per process, lazily, so a process that never validates a
 * diagram never builds a DOM.
 */
let domReady = false
async function ensureDom(): Promise<void> {
  if (domReady || typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    domReady = true
    return
  }
  const { Window } = await import('happy-dom')
  const w = new Window()
  const g = globalThis as unknown as Record<string, unknown>
  g.window = w
  g.document = w.document
  g.DOMParser = w.DOMParser
  g.Node = w.Node
  g.HTMLElement = w.HTMLElement
  domReady = true
}

/**
 * Does this text parse as a mermaid diagram?
 *
 * A diagram that does not parse is an ANSWER, not a request failure — callers
 * get `{ ok: false }` with a 200, and the route below keeps that distinction.
 */
export async function checkMermaid(source: string): Promise<MermaidCheck> {
  try {
    await ensureDom()
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    // Normalised HERE and nowhere else. The grammar has no business seeing a
    // \r, but the document keeps its own line endings — normalising at the
    // reader would hand every caller a rewritten fence.
    await mermaid.parse(source.replace(/\r\n/g, '\n'))
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message, line: lineFromParseError(message) }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Same constant-time compare as artifacts, vault and workspace-docs. */
function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readRawBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        over = true
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * POST /workspace-docs/diagram/check  { mermaid } -> 200 { ok } | 200 { ok:false, error, line }
 *
 * NO KEY, NO NETWORK, NO COST. That is the point rather than an implementation
 * detail: validation has to work on a machine that never configured a model and
 * during a provider outage, so this route contacts nothing. The paid route
 * (TASK-1936) is a separate path for the same reason `/claude-config/review` is
 * separate from `/validate` — a flag can be defaulted on by a refactor, a
 * missing route cannot.
 */
export async function handleWorkspaceDiagramRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { bridgeToken: string }
): Promise<boolean> {
  const rawPath = (req.url ?? '/').split('?')[0]
  if (rawPath !== CHECK_ROUTE) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, opts.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const raw = await readRawBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return true
  }
  let parsed: { mermaid?: unknown }
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as typeof parsed)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }
  if (typeof parsed.mermaid !== 'string' || parsed.mermaid.trim() === '') {
    sendJson(res, 400, { error: 'mermaid is required' })
    return true
  }

  sendJson(res, 200, await checkMermaid(parsed.mermaid))
  return true
}
