// TASK-1934 — one test per acceptance criterion.
//
// The fixtures are the two diagrams that actually broke, copied byte-for-byte
// out of ABCV2's docs/knowledge on 2026-09-10, each paired with the form it was
// repaired into. The pairing is the whole point: a checker that answers the
// same for both is a checker that cannot fail, and it would have passed every
// assertion in this file if only the broken halves were tested.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import { listMermaidFences, checkMermaid } from './mermaid-check'

const TOKEN = 'mermaid-check-test-token'

// --- the two real defects, verbatim ------------------------------------------

/**
 * `&gt;` is decoded by mermaid before the grammar sees it, so the message text
 * turns into an arrow and the line stops being a message. This shipped in an
 * ADR and rendered as "Syntax error in text" for anyone who opened it.
 */
const BROKEN_ENTITY = [
  'sequenceDiagram',
  '    participant H',
  '    participant LA',
  '    H-->>LA: PageResult&lt;AccountListItem&gt;',
  '    LA-->>H: NormalizedToolResult'
].join('\n')

/** The repair: mermaid's own escapes, which survive its entity decoding. */
const FIXED_ENTITY = BROKEN_ENTITY.replace(
  'PageResult&lt;AccountListItem&gt;',
  'PageResult#lt;AccountListItem#gt;'
)

/** An unquoted `{{` in a node label. Same document family, different grammar. */
const BROKEN_BRACES = [
  'flowchart TB',
  '    subgraph Auth["Auth / Credentials"]',
  '        SS[SecretStore\\n{{secrets.KEY}}]',
  '        BS[BearerStatic]',
  '    end'
].join('\n')

/** The repair: quote the label, so the braces are text rather than syntax. */
const FIXED_BRACES = BROKEN_BRACES.replace(
  'SS[SecretStore\\n{{secrets.KEY}}]',
  'SS["SecretStore\\n{{secrets.KEY}}"]'
)

const FIXTURE = path.join(__dirname, '__fixtures__', 'adr-pure-mcp-tools-as-module-adapter.md')

// --- server harness ----------------------------------------------------------

let handle: CompanionServerHandle
let base: string

/**
 * Records every outbound call. AC-2 is not "the response looked right" — it is
 * "nothing left the machine", and only a recorder can say that.
 */
const fetchCalls: string[] = []

beforeAll(async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = ((url: string | URL | Request, init?: unknown) => {
    fetchCalls.push(String(url))
    return (realFetch as typeof fetch)(url as string, init as RequestInit)
  }) as typeof fetch

  const services = {
    svc: {} as unknown,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
})

/** The route's two shapes plus the error bodies its guards return. */
type CheckBody = { ok?: boolean; error?: string; line?: number | null }

async function check(
  body: unknown,
  token: string = TOKEN
): Promise<{ status: number; json: CheckBody }> {
  const res = await fetch(`${base}/workspace-docs/diagram/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-choda-bridge-token': token },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: (await res.json()) as CheckBody }
}

// -----------------------------------------------------------------------------

describe('AC-1 — the two real defects are rejected, and their repairs are not', () => {
  it('the decoded-entity diagram is refused with a line number', async () => {
    const { status, json } = await check({ mermaid: BROKEN_ENTITY })
    expect(status).toBe(200) // a diagram that does not parse is an ANSWER
    expect(json.ok).toBe(false)
    expect(typeof json.error).toBe('string')
    expect(json.line).toBe(4)
  })

  it('CONTROL — the same diagram with mermaid escapes parses', async () => {
    // Without this the check above passes against a route that refuses
    // everything, which is the failure mode this whole task exists to prevent.
    const { status, json } = await check({ mermaid: FIXED_ENTITY })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
  })

  it('the unquoted `{{` label is refused', async () => {
    const { json } = await check({ mermaid: BROKEN_BRACES })
    expect(json.ok).toBe(false)
  })

  it('CONTROL — quoting the label makes it parse', async () => {
    const { json } = await check({ mermaid: FIXED_BRACES })
    expect(json.ok).toBe(true)
  })
})

describe('AC-2 — free, keyless, and offline', () => {
  it('answers with no key configured and issues no outbound request', async () => {
    const before = fetchCalls.length
    const { status, json } = await check({ mermaid: 'sequenceDiagram\n  A->>B: hi' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    // Only this test's own request to the local server may appear; nothing may
    // have gone to a provider.
    const outbound = fetchCalls.slice(before).filter((u) => !u.includes(COMPANION_BIND))
    expect(outbound).toEqual([])
  })
})

describe('AC-3 — fences are located in the real document', () => {
  it('finds the three fences and slices back to exactly their bodies', () => {
    const md = fs.readFileSync(FIXTURE, 'utf8')
    const fences = listMermaidFences(md)
    expect(fences).toHaveLength(3)

    const lines = md.split('\n')
    for (const f of fences) {
      // The slice is the code and nothing else — no ``` markers on either end.
      expect(lines.slice(f.start - 1, f.end).join('\n')).toBe(f.code)
      expect(f.code.startsWith('```')).toBe(false)
      expect(f.code.trimEnd().endsWith('```')).toBe(false)
    }
    expect(fences[0]!.code.startsWith('sequenceDiagram')).toBe(true)
    expect(fences[2]!.code.startsWith('flowchart TD')).toBe(true)
  })

  it('CONTROL — a document with no fence returns none', () => {
    expect(listMermaidFences('# just prose\n\nnothing here\n')).toEqual([])
  })

  it('every fence in the real document parses, now that both defects are fixed', async () => {
    const fences = listMermaidFences(fs.readFileSync(FIXTURE, 'utf8'))
    for (const f of fences) {
      expect(await checkMermaid(f.code)).toEqual({ ok: true })
    }
  })
})

describe('AC-4 — CRLF is found, not silently skipped', () => {
  it('a CRLF document yields the same fence count as its LF twin', () => {
    const lf = fs.readFileSync(FIXTURE, 'utf8')
    // Built by explicit joining rather than by committing a CRLF file, which
    // git may normalise on checkout — the fixture would then quietly become an
    // LF file and this test would pass while proving nothing.
    const crlf = lf.split('\n').join('\r\n')
    expect(listMermaidFences(crlf)).toHaveLength(listMermaidFences(lf).length)
    expect(listMermaidFences(crlf)[0]!.code).toBe(listMermaidFences(lf)[0]!.code)
  })

  it('a CRLF fence still parses — the \\r must not reach the grammar', async () => {
    const crlf = 'sequenceDiagram\r\n  A->>B: hi\r\n'
    const fences = listMermaidFences('```mermaid\r\n' + crlf + '```\r\n')
    expect(fences).toHaveLength(1)
    expect(await checkMermaid(fences[0]!.code)).toEqual({ ok: true })
  })
})

describe('the route’s own guards', () => {
  it('a wrong token is refused before anything is parsed', async () => {
    const { status } = await check({ mermaid: BROKEN_ENTITY }, 'not-the-token')
    expect(status).toBe(401)
  })

  it('a missing `mermaid` field is a 400, not an ok:false', async () => {
    // These are different answers: 400 means the request was malformed, ok:false
    // means the diagram was. Collapsing them would report every client bug as a
    // broken diagram.
    const { status, json } = await check({})
    expect(status).toBe(400)
    expect(json.ok).toBeUndefined()
  })

  it('the route is not shadowed by /workspace-docs/<ws>/<rel>', async () => {
    // Registration order is load-bearing: this path matches the docs route's
    // prefix, and if it were registered second the answer would be a 404 for
    // workspace "diagram" instead of a validation result.
    const { status, json } = await check({ mermaid: 'sequenceDiagram\n  A->>B: hi' })
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
  })
})
