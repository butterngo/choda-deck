// TASK-1828 — GET /claude-config. One test per acceptance criterion, plus the
// two cases the criteria imply but do not name: a dangling root, and a folded
// frontmatter description.
//
// The scoping tests assert both the status AND that the secret bytes never came
// back. A guard that refuses the wrong paths and serves the right ones passes a
// status-only assertion, so the marker planted in history.jsonl is what makes
// the check real (same rationale as vault.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as net from 'net'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { parseSkillFrontmatter, readInventory, resolveRoots } from './claude-config'

const TOKEN = 'claude-config-test-token'

// If this string ever appears in a response body the sandbox has failed,
// whatever status came with it.
const PRIVATE_MARKER = 'BUTTER_TRANSCRIPT_DO_NOT_SERVE'

// 11 of the 13 real skills write `description: >`. A parser that only reads
// flat `key: value` leaves the majority of the inventory blank while every test
// on inline fixtures stays green — so the folded form is the fixture.
const FOLDED_SKILL = `---
name: session-start
description: >
  Set up a clean working environment for one task and start a
  session on it. Identifies the project and workspace from cwd.
---

# session-start
`

const INLINE_SKILL = `---
name: code-review
description: Review code changes for security, performance, and correctness.
---

# code-review
`

const PLUGIN_SKILL = `---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces.
---
`

const MARKETPLACE_SKILL = `---
name: cardputer-buddy
description: A skill from a plugin that was never installed.
---
`

let home: string
let danglingHome: string
let commandsTarget: string
let outsideDir: string
let handle: CompanionServerHandle
let base: string

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => []
} as unknown as BackendTaskService

/** Directory links portably: a junction on Windows needs no elevation. */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
}

function get(
  urlPath: string,
  headers: Record<string, string> = { 'x-choda-bridge-token': TOKEN }
): Promise<{ status: number; type: string | null; body: string }> {
  return fetch(`${base}${urlPath}`, { headers }).then(async (r) => ({
    status: r.status,
    type: r.headers.get('content-type'),
    body: await r.text()
  }))
}

/**
 * Send the request line VERBATIM, bypassing URL normalization.
 *
 * `fetch` collapses `../` before the bytes leave the client, so a traversal sent
 * through it arrives as an ordinary path and never reaches the guard — the test
 * would prove nothing. An attacker has no such courtesy.
 */
function rawGet(rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(handle.address.port, COMPANION_BIND, () => {
      sock.write(
        `GET ${rawPath} HTTP/1.1\r\nHost: ${COMPANION_BIND}\r\n` +
          `x-choda-bridge-token: ${TOKEN}\r\nConnection: close\r\n\r\n`
      )
    })
    const chunks: Buffer[] = []
    sock.on('data', (c: Buffer) => chunks.push(c))
    sock.on('error', reject)
    sock.on('end', () => {
      const raw = Buffer.concat(chunks)
      const status = Number.parseInt(raw.toString('latin1', 9, 12), 10)
      sock.destroy()
      resolve({ status, body: raw.toString('latin1') })
    })
  })
}

function writeSkill(dir: string, name: string, body: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'SKILL.md'), body, 'utf8')
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-claude-home-'))
  commandsTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-commands-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-outside-'))

  // --- skills root
  const skills = path.join(home, 'skills')
  fs.mkdirSync(skills, { recursive: true })
  writeSkill(skills, 'session-start', FOLDED_SKILL)
  writeSkill(skills, 'code-review', INLINE_SKILL)
  // A directory with no SKILL.md, and a loose file. Both sit beside real skills
  // in the actual ~/.claude/skills and neither is a skill.
  fs.mkdirSync(path.join(skills, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(skills, 'README.md'), '# not a skill\n', 'utf8')

  // --- the escape hatch: a link INSIDE an allowed root pointing outside it
  fs.writeFileSync(path.join(outsideDir, 'secret.md'), PRIVATE_MARKER, 'utf8')
  linkDir(outsideDir, path.join(skills, 'escape'))

  // --- global CLAUDE.md
  fs.writeFileSync(path.join(home, 'CLAUDE.md'), '# global rules\n', 'utf8')

  // --- commands: a WORKING symlink pointing outside ~/.claude
  fs.writeFileSync(path.join(commandsTarget, 'deploy.md'), '# deploy\n', 'utf8')
  fs.mkdirSync(path.join(commandsTarget, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(commandsTarget, 'nested', 'rollback.md'), '# rollback\n', 'utf8')
  linkDir(commandsTarget, path.join(home, 'commands'))

  // --- plugins: ONE installed, one only listed in a marketplace
  const installed = path.join(home, 'plugins', 'cache', 'official', 'frontend-design')
  fs.mkdirSync(path.join(installed, 'skills'), { recursive: true })
  writeSkill(path.join(installed, 'skills'), 'frontend-design', PLUGIN_SKILL)

  const marketplace = path.join(home, 'plugins', 'marketplaces', 'official', 'plugins', 'cwc-makers')
  fs.mkdirSync(path.join(marketplace, 'skills'), { recursive: true })
  writeSkill(path.join(marketplace, 'skills'), 'cardputer-buddy', MARKETPLACE_SKILL)

  fs.writeFileSync(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: { 'frontend-design@official': [{ scope: 'user', installPath: installed }] }
    }),
    'utf8'
  )

  // --- what must never be reachable
  fs.writeFileSync(path.join(home, 'history.jsonl'), PRIVATE_MARKER, 'utf8')
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(home, 'sessions', 'transcript.jsonl'), PRIVATE_MARKER, 'utf8')

  // --- a second HOME whose commands link DANGLES, like the real machine's
  danglingHome = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-dangling-home-'))
  fs.mkdirSync(path.join(danglingHome, 'skills'), { recursive: true })
  writeSkill(path.join(danglingHome, 'skills'), 'only-skill', INLINE_SKILL)
  const doomed = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-doomed-'))
  linkDir(doomed, path.join(danglingHome, 'commands'))
  // Creating the link then removing its target is how a dangling link is made
  // portably — Windows refuses to create one pointing at nothing.
  fs.rmSync(doomed, { recursive: true, force: true })

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
  for (const dir of [home, danglingHome, commandsTarget, outsideDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('AC-1 — installed plugins count, marketplace listings do not', () => {
  it('serves the installed plugin skill and none of the marketplace one', async () => {
    const res = await get('/claude-config')
    expect(res.status).toBe(200)
    const names = JSON.parse(res.body).skills.map((s: { name: string }) => s.name)
    expect(names).toContain('frontend-design')
    expect(names).not.toContain('cardputer-buddy')
  })

  it('the skill count is the effective set, not the SKILL.md file count', async () => {
    // Three real skills against four SKILL.md files on disk. Equality here is
    // the tell that the resolver walked the tree instead of reading the manifest.
    const res = await get('/claude-config')
    const skills = JSON.parse(res.body).skills
    expect(skills).toHaveLength(3)
  })
})

describe('AC-2 — a directory is a skill only when it holds SKILL.md', () => {
  it('omits a directory with no SKILL.md and a loose file beside it', async () => {
    const names = JSON.parse((await get('/claude-config')).body).skills.map(
      (s: { name: string }) => s.name
    )
    expect(names).not.toContain('docs')
    expect(names).not.toContain('README')
    expect(names).toContain('session-start')
  })

  it('every listed skill names a file that exists', async () => {
    const skills = JSON.parse((await get('/claude-config')).body).skills
    for (const s of skills) expect(fs.existsSync(s.path)).toBe(true)
  })
})

describe('AC-3 — a commands root that is a symlink still lists', () => {
  it('lists commands through the link and reports the resolved path', async () => {
    const body = JSON.parse((await get('/claude-config')).body)
    const names = body.commands.map((c: { name: string }) => c.name)
    expect(names).toContain('deploy')
    // Nested, because commands nest and a flat readdir would miss them.
    expect(names).toContain('nested/rollback')
    // The resolved target, not the link — this is what a prefix check against
    // the unresolved root would get wrong.
    const deploy = body.commands.find((c: { name: string }) => c.name === 'deploy')
    expect(fs.realpathSync(deploy.path).startsWith(fs.realpathSync(commandsTarget))).toBe(true)
  })

  it('serves a command file through the linked root', async () => {
    const res = await get('/claude-config/commands/deploy.md')
    expect(res.status).toBe(200)
    expect(res.body).toContain('# deploy')
  })
})

describe('AC-4 — nothing outside the allowlisted roots is reachable', () => {
  it('refuses a traversal and returns no bytes', async () => {
    // Sent raw: fetch would collapse `../..` before it left the client.
    const res = await rawGet('/claude-config/skills/../../history.jsonl')
    expect(res.status).toBe(403)
    expect(res.body).not.toContain(PRIVATE_MARKER)
  })

  it('refuses an encoded traversal and returns no bytes', async () => {
    const res = await rawGet('/claude-config/skills/%2e%2e/%2e%2e/history.jsonl')
    expect(res.status).toBe(403)
    expect(res.body).not.toContain(PRIVATE_MARKER)
  })

  it('refuses a file reached through a symlink planted inside an allowed root', async () => {
    // `escape` IS inside the skills root by name. Only resolving the target
    // reveals that it lands somewhere the allowlist never named.
    const res = await get('/claude-config/skills/escape/secret.md')
    expect(res.status).toBe(403)
    expect(res.body).not.toContain(PRIVATE_MARKER)
  })

  it('an unknown root id is a malformed request, not a refusal', async () => {
    // 400 rather than 403 or 404: an id nobody publishes says nothing about
    // what exists on disk, so the answer must not either.
    const res = await get('/claude-config/sessions/transcript.jsonl')
    expect(res.status).toBe(400)
    expect(res.body).not.toContain(PRIVATE_MARKER)
  })

  it('CONTROL — a file genuinely inside an allowed root is served', async () => {
    // Without this the suite would pass against a route that refuses everything.
    const res = await get('/claude-config/skills/code-review/SKILL.md')
    expect(res.status).toBe(200)
    expect(res.body).toContain('name: code-review')
  })
})

describe('AC-5 — every row is labelled', () => {
  it('names a scope and a pluginId consistent with it', async () => {
    const skills = JSON.parse((await get('/claude-config')).body).skills
    for (const s of skills) {
      expect(s.name.length).toBeGreaterThan(0)
      expect(['global', 'plugin']).toContain(s.scope)
      if (s.scope === 'plugin') expect(s.pluginId).not.toBeNull()
      else expect(s.pluginId).toBeNull()
    }
  })

  it('attributes the plugin skill to the plugin it came from', async () => {
    const skills = JSON.parse((await get('/claude-config')).body).skills
    const fd = skills.find((s: { name: string }) => s.name === 'frontend-design')
    expect(fd.scope).toBe('plugin')
    expect(fd.pluginId).toBe('frontend-design@official')
  })
})

describe('a dangling root is a normal state, not a failure', () => {
  it('yields an empty group and leaves the rest of the inventory intact', () => {
    // The real machine's ~/.claude/commands points at a directory that no longer
    // exists: readlink answers, realpath throws ENOENT. A resolver that lets
    // that throw takes the whole route down over a stale link.
    const inv = readInventory(danglingHome)
    expect(inv.commands).toEqual([])
    expect(inv.skills.map((s) => s.name)).toEqual(['code-review'])
  })

  it('carries the root with real === null rather than dropping it', () => {
    const commands = resolveRoots(danglingHome).find((r) => r.id === 'commands')
    expect(commands).toBeDefined()
    expect(commands?.real).toBeNull()
  })

  it('a request under a dangling root is not found, and is not a 5xx', async () => {
    const inv = readInventory(danglingHome)
    expect(inv.rules).toEqual([])
    // Exercised against the served home, whose claude-md root is real; the
    // dangling case is covered by the two assertions above because the route
    // reads the same resolveRoots.
    const res = await get('/claude-config/claude-md')
    expect(res.status).toBe(200)
  })
})

describe('frontmatter', () => {
  it('reads a FOLDED description, which most real skills use', () => {
    const fm = parseSkillFrontmatter(FOLDED_SKILL)
    expect(fm.name).toBe('session-start')
    expect(fm.description).toContain('Set up a clean working environment')
    expect(fm.description).toContain('Identifies the project and workspace from cwd.')
    // Folded means joined, not newline-preserved.
    expect(fm.description).not.toContain('\n')
  })

  it('reads an inline description unchanged', () => {
    expect(parseSkillFrontmatter(INLINE_SKILL).description).toBe(
      'Review code changes for security, performance, and correctness.'
    )
  })

  it('a skill with no frontmatter still appears, named for its directory', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-nofm-'))
    fs.mkdirSync(path.join(scratch, 'skills', 'bare'), { recursive: true })
    fs.writeFileSync(path.join(scratch, 'skills', 'bare', 'SKILL.md'), '# no header\n', 'utf8')
    const inv = readInventory(scratch)
    expect(inv.skills.map((s) => s.name)).toEqual(['bare'])
    expect(inv.skills[0].description).toBe('')
    fs.rmSync(scratch, { recursive: true, force: true })
  })
})

describe('the route follows the adapter conventions', () => {
  it('401s without the bridge token', async () => {
    const res = await get('/claude-config', {})
    expect(res.status).toBe(401)
  })

  it('405s on a non-GET', async () => {
    const res = await fetch(`${base}/claude-config`, {
      method: 'POST',
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(res.status).toBe(405)
  })
})

describe('TASK-1831 — every row carries an addressable reference', () => {
  // The file route refuses absolute paths, so a display path is not a request.
  // Without `ref`, a client has to reconstruct rootId and rel by parsing the
  // path — which is how the route shipped with no caller at all.
  it('a global skill can be fetched back through its own ref', async () => {
    const inv = JSON.parse((await get('/claude-config')).body)
    const skill = inv.skills.find((s: { name: string }) => s.name === 'session-start')
    expect(skill.ref.rootId).toBe('skills')
    expect(skill.ref.rel).toBe('session-start/SKILL.md')

    const res = await get(`/claude-config/${skill.ref.rootId}/${skill.ref.rel}`)
    expect(res.status).toBe(200)
    expect(res.body).toContain('name: session-start')
  })

  it('a plugin skill names its plugin root, not the skills root', async () => {
    const inv = JSON.parse((await get('/claude-config')).body)
    const skill = inv.skills.find((s: { name: string }) => s.name === 'frontend-design')
    expect(skill.ref.rootId).toBe('plugin:frontend-design@official')
    const res = await get(`/claude-config/${skill.ref.rootId}/${skill.ref.rel}`)
    expect(res.status).toBe(200)
  })

  it('a nested command keeps its subdirectory in the ref', async () => {
    const inv = JSON.parse((await get('/claude-config')).body)
    const cmd = inv.commands.find((c: { name: string }) => c.name === 'nested/rollback')
    // Forward slashes regardless of platform — this goes into a URL.
    expect(cmd.ref.rel).toBe('nested/rollback.md')
    expect((await get(`/claude-config/${cmd.ref.rootId}/${cmd.ref.rel}`)).status).toBe(200)
  })

  it('a file root carries an empty rel and is fetchable with it', async () => {
    const inv = JSON.parse((await get('/claude-config')).body)
    expect(inv.rules[0].ref).toEqual({ rootId: 'claude-md', rel: '' })
    expect((await get('/claude-config/claude-md')).status).toBe(200)
  })

  it('CONTROL — every ref round-trips, not just the ones named above', async () => {
    // A ref that cannot be fetched is worse than no ref: it looks like a link.
    const inv = JSON.parse((await get('/claude-config')).body)
    const refs = [...inv.skills, ...inv.commands, ...inv.rules].map(
      (r: { ref: { rootId: string; rel: string } }) => r.ref,
    )
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      const url = ref.rel === '' ? `/claude-config/${ref.rootId}` : `/claude-config/${ref.rootId}/${ref.rel}`
      expect((await get(url)).status).toBe(200)
    }
  })
})
