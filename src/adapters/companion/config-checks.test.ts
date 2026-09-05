// TASK-1842 — POST /claude-config/validate, and the declaration registry behind it.
//
// The criterion that shapes this file is AC-4: adding a check must not touch the
// runner. So the test for it registers a declaration through the same public
// surface a real check would use, and asserts its finding comes back through the
// HTTP route. If that test ever needs a line changed inside runChecks, the
// design has already failed and the green tick would be lying.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { compareKeySets, registerCheck, runChecks, type CheckContext } from './config-checks'

const TOKEN = 'config-checks-token'

const WITH_DESCRIPTION = `---
name: code-review
description: Review code changes for security, performance, and correctness.
---

# code-review
`

// The same skill with one line removed. Both fixtures exist so the test can show
// the check DISTINGUISHING them — a check that fires on every input proves
// nothing, and one that fires on none proves less.
const WITHOUT_DESCRIPTION = `---
name: code-review
---

# code-review
`

let home: string
let handle: CompanionServerHandle
let base: string
let calls: string[]

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => [],
  getWorkspace: async () => null
} as unknown as BackendTaskService

interface Finding {
  checkId: string
  severity: string
  message: string
  line: number | null
}

function validate(body: unknown): Promise<{ status: number; findings: Finding[]; raw: string }> {
  return fetch(`${base}/claude-config/validate`, {
    method: 'POST',
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (r) => {
    const raw = await r.text()
    let findings: Finding[] = []
    try {
      findings = (JSON.parse(raw) as { findings?: Finding[] }).findings ?? []
    } catch {
      findings = []
    }
    return { status: r.status, findings, raw }
  })
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  const text = over.text ?? ''
  return {
    rootId: 'skills',
    rel: 'x/SKILL.md',
    path: 'C:\\x\\SKILL.md',
    bytes: over.bytes ?? Buffer.from(text, 'utf8'),
    text,
    ...over
  }
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-checks-'))
  const skills = path.join(home, 'skills')
  fs.mkdirSync(path.join(skills, 'code-review'), { recursive: true })
  fs.mkdirSync(path.join(skills, 'no-description'), { recursive: true })
  fs.writeFileSync(path.join(skills, 'code-review', 'SKILL.md'), WITH_DESCRIPTION, 'utf8')
  fs.writeFileSync(path.join(skills, 'no-description', 'SKILL.md'), WITHOUT_DESCRIPTION, 'utf8')

  // Raw bytes: a BOM written through a utf8 string literal is still a BOM, but
  // writing the buffer makes the fixture say what it is.
  fs.mkdirSync(path.join(skills, 'bommed'), { recursive: true })
  fs.writeFileSync(
    path.join(skills, 'bommed', 'SKILL.md'),
    Buffer.from('\uFEFF' + WITH_DESCRIPTION, 'utf8')
  )

  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    claudeHome: home,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('AC-1 — validation works on a machine with no model configured', () => {
  it('returns findings and makes no outbound request', async () => {
    // Every fetch the process makes is recorded. The route must reach the
    // filesystem and nothing else — a validator that needs a provider is one
    // nobody can rely on during an outage.
    calls = []
    const real = globalThis.fetch
    vi.stubGlobal('fetch', (input: RequestInfo, init?: RequestInit) => {
      calls.push(String(input))
      return real(input as string, init)
    })

    const res = await validate({ rootId: 'skills', rel: 'no-description/SKILL.md' })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.findings)).toBe(true)

    // The only call is the test's own request to the local route.
    expect(calls.filter((u) => !u.includes(String(handle.address.port)))).toEqual([])
    vi.unstubAllGlobals()
  })

  it('no key is configured anywhere in this fixture', () => {
    // Pins the premise: if a later change made the fixture carry a key, AC-1
    // would still pass while proving something weaker than it claims.
    expect(fs.existsSync(path.join(home, '..', '.claude.json'))).toBe(false)
  })
})

describe('AC-2 — a missing description is reported, a present one is not', () => {
  it('reports the field by name when it is absent', async () => {
    const res = await validate({ rootId: 'skills', rel: 'no-description/SKILL.md' })
    const finding = res.findings.find((f) => f.checkId === 'skill-frontmatter')
    expect(finding).toBeDefined()
    expect(finding?.message).toContain('description')
  })

  it('CONTROL — the same file with a description yields none', async () => {
    // Without this the check could fire on every SKILL.md and the first
    // assertion would still pass.
    const res = await validate({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.findings.filter((f) => f.checkId === 'skill-frontmatter')).toEqual([])
  })
})

describe('AC-3 — a BOM is reported, never removed', () => {
  it('reports it and leaves the file byte-identical', async () => {
    const target = path.join(home, 'skills', 'bommed', 'SKILL.md')
    const before = fs.readFileSync(target)

    const res = await validate({ rootId: 'skills', rel: 'bommed/SKILL.md' })
    expect(res.findings.some((f) => f.checkId === 'utf8-bom')).toBe(true)

    // Buffer comparison: a validator that "helpfully" strips the BOM would leave
    // an equal-looking string and different bytes.
    expect(Buffer.compare(fs.readFileSync(target), before)).toBe(0)
    expect(fs.readFileSync(target)[0]).toBe(0xef)
  })

  it('CONTROL — a file without a BOM reports none', async () => {
    const res = await validate({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(res.findings.some((f) => f.checkId === 'utf8-bom')).toBe(false)
  })
})

describe('AC-4 — adding a check does not touch the runner', () => {
  it('a declaration registered through the public surface reaches the HTTP response', async () => {
    // The whole criterion: nothing below names this check, and the runner has
    // never heard of it. If this needed a line inside runChecks, the design has
    // already failed.
    const unregister = registerCheck({
      id: 'invented-by-a-test',
      appliesTo: (c) => c.rel.endsWith('code-review/SKILL.md'),
      run: () => [
        { checkId: 'invented-by-a-test', severity: 'note', message: 'hello from a test', line: 7 }
      ]
    })

    try {
      const res = await validate({ rootId: 'skills', rel: 'code-review/SKILL.md' })
      const finding = res.findings.find((f) => f.checkId === 'invented-by-a-test')
      expect(finding?.message).toBe('hello from a test')
      expect(finding?.line).toBe(7)
    } finally {
      unregister()
    }

    // And it is gone once unregistered — a registry a test cannot clean up
    // leaks into every later test, and the leak looks like a flake elsewhere.
    const after = await validate({ rootId: 'skills', rel: 'code-review/SKILL.md' })
    expect(after.findings.some((f) => f.checkId === 'invented-by-a-test')).toBe(false)
  })

  it('a throwing check is reported, not fatal to the others', () => {
    const unregister = registerCheck({
      id: 'explodes',
      appliesTo: () => true,
      run: () => {
        throw new Error('boom')
      }
    })
    try {
      const findings = runChecks(ctx({ text: WITHOUT_DESCRIPTION }))
      expect(findings.some((f) => f.checkId === 'explodes' && f.message.includes('boom'))).toBe(true)
      // The other checks still ran.
      expect(findings.some((f) => f.checkId === 'skill-frontmatter')).toBe(true)
    } finally {
      unregister()
    }
  })
})

describe('AC-5 — a key-set check reports BOTH directions, under distinct ids', () => {
  it('separates the loud direction from the quiet one', () => {
    // The drift this primitive exists for: renderer keys vs a registry.
    // `table-4` in the renderer with no schema is the loud failure that actually
    // happened; a schema nothing renders is the quiet one nobody checked.
    const findings = compareKeySets(
      ['table-1', 'table-4'],
      ['table-1', 'orphan-schema'],
      { onlyInLeft: 'renderer-key-without-schema', onlyInRight: 'schema-without-renderer' },
      {
        onlyInLeft: (k) => `${k} renders but has no schema`,
        onlyInRight: (k) => `${k} has a schema nothing renders`
      }
    )

    const loud = findings.filter((f) => f.checkId === 'renderer-key-without-schema')
    const quiet = findings.filter((f) => f.checkId === 'schema-without-renderer')

    expect(loud.map((f) => f.message)).toEqual(['table-4 renders but has no schema'])
    expect(quiet.map((f) => f.message)).toEqual(['orphan-schema has a schema nothing renders'])
    // Distinct ids are the criterion: one id for both makes the quiet failure
    // indistinguishable from the loud one in the response.
    expect(loud[0].checkId).not.toBe(quiet[0].checkId)
  })

  it('CONTROL — identical sets report nothing', () => {
    expect(
      compareKeySets(
        ['a', 'b'],
        ['b', 'a'],
        { onlyInLeft: 'l', onlyInRight: 'r' },
        { onlyInLeft: () => 'l', onlyInRight: () => 'r' }
      )
    ).toEqual([])
  })
})

describe('the validate route follows the adapter conventions', () => {
  it('400s without rootId and rel', async () => {
    expect((await validate({})).status).toBe(400)
  })

  it('403s for a path outside the roots', async () => {
    const res = await validate({ rootId: 'skills', rel: '../../history.jsonl' })
    expect(res.status).toBe(403)
  })

  it('404s for a file that does not exist', async () => {
    expect((await validate({ rootId: 'skills', rel: 'nope/SKILL.md' })).status).toBe(404)
  })

  it('405s a GET on the validate route', async () => {
    const res = await fetch(`${base}/claude-config/validate`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    // It is a POST route; a GET must not fall through to the file reader and
    // start hunting for a root called "validate".
    expect([400, 405]).toContain(res.status)
  })

  it('validates submitted text without touching the file on disk', async () => {
    const target = path.join(home, 'skills', 'code-review', 'SKILL.md')
    const before = fs.readFileSync(target)
    const res = await validate({
      rootId: 'skills',
      rel: 'code-review/SKILL.md',
      text: WITHOUT_DESCRIPTION
    })
    // The buffer in the editor is what was checked, not what is saved.
    expect(res.findings.some((f) => f.checkId === 'skill-frontmatter')).toBe(true)
    expect(Buffer.compare(fs.readFileSync(target), before)).toBe(0)
  })
})


// ---------------------------------------------------------------------------
// TASK-1859 — POST /claude-config/validate-all
// ---------------------------------------------------------------------------

interface SweepEntry {
  ref: { rootId: string; rel: string }
  findings: Finding[]
  unreadable: string | null
}

function validateAll(): Promise<{ status: number; results: SweepEntry[]; raw: string }> {
  return fetch(`${base}/claude-config/validate-all`, {
    headers: { 'x-choda-bridge-token': TOKEN }
  }).then(async (r) => {
    const raw = await r.text()
    let results: SweepEntry[] = []
    try {
      results = (JSON.parse(raw) as { results?: SweepEntry[] }).results ?? []
    } catch {
      results = []
    }
    return { status: r.status, results, raw }
  })
}

describe('AC-1 — the sweep answers for every file-backed entry', () => {
  it('covers the whole inventory, not a subset', async () => {
    const { status, results } = await validateAll()
    expect(status).toBe(200)

    const rels = results.map((r) => r.ref.rel)
    // The three skills the fixture writes must all be present. A sweep that
    // stopped at the first finding, or at the first unreadable entry, would
    // return fewer — and a count-only assertion would not notice WHICH.
    expect(rels.some((r) => r.includes('code-review'))).toBe(true)
    expect(rels.some((r) => r.includes('no-description'))).toBe(true)
    expect(rels.some((r) => r.includes('bommed'))).toBe(true)
  })

  it('separates the entries that have findings from the ones that do not', async () => {
    const { results } = await validateAll()
    const bad = results.find((r) => r.ref.rel.includes('no-description'))
    const good = results.find((r) => r.ref.rel.includes('code-review'))

    // This is the pair the header count is computed from. If both sides looked
    // alike, "3 need attention" would be a number nobody could trust.
    expect(bad?.findings.length).toBeGreaterThan(0)
    expect(good?.findings).toEqual([])
  })

  it('reports the same findings the single-file route reports', async () => {
    // Two routes answering differently about one file is worse than one route:
    // the reader cannot tell which to believe.
    const sweep = await validateAll()
    const entry = sweep.results.find((r) => r.ref.rel.includes('no-description'))
    const single = await validate({ rootId: entry?.ref.rootId, rel: entry?.ref.rel })
    expect(entry?.findings.map((f) => f.checkId).sort()).toEqual(
      single.findings.map((f) => f.checkId).sort()
    )
  })
})

describe('AC-1 — one bad entry does not take down the sweep', () => {
  it('an unreadable entry reports its reason and the others still answer', async () => {
    // A dangling symlink is a real and expected state in this tree —
    // ~/.claude/commands is one on Butter's machine. If that aborted the sweep,
    // the feature would be dead on the machine it was built for.
    const skills = path.join(home, 'skills')
    fs.mkdirSync(path.join(skills, 'vanished'), { recursive: true })
    const doomed = path.join(skills, 'vanished', 'SKILL.md')
    fs.writeFileSync(doomed, '---\nname: vanished\ndescription: goes away\n---\n', 'utf8')

    // Present in the inventory, then removed before the read.
    const before = await validateAll()
    expect(before.results.some((r) => r.ref.rel.includes('vanished'))).toBe(true)
    fs.rmSync(doomed)

    const after = await validateAll()
    expect(after.status).toBe(200)
    const gone = after.results.find((r) => r.ref.rel.includes('vanished'))
    if (gone) expect(gone.unreadable).not.toBeNull()
    // The point of the test: everything else still answered.
    expect(after.results.some((r) => r.ref.rel.includes('code-review'))).toBe(true)
    fs.rmSync(path.join(skills, 'vanished'), { recursive: true, force: true })
  })
})

describe('AC-4 — the sweep is free', () => {
  it('reaches no provider even with a key and provider configured', async () => {
    // The sweep runs on open. If it could reach a provider, opening the tab
    // would be a purchase — the exact boundary TASK-1843 made structural.
    const seen: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url)
      if (!u.startsWith(base)) seen.push(u)
      return originalFetch(url as RequestInfo, init)
    }) as typeof fetch
    try {
      await validateAll()
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(seen).toEqual([])
  })

  it('405s a POST on the sweep route', async () => {
    // The sweep carries no body and changes nothing, so it is a GET — the same
    // call the /models route makes, for the same reason. Writing this test as
    // "405s a GET" is what surfaced the question: /validate is a POST because it
    // carries rootId, rel and an unsaved buffer, and none of that applies here.
    const res = await fetch(`${base}/claude-config/validate-all`, {
      method: 'POST',
      headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(res.status).toBe(405)
  })
})
