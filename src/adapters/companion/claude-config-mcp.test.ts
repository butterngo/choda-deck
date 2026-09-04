// TASK-1829 — MCP servers as a projection of .claude.json and a repo's
// .mcp.json. One test per acceptance criterion.
//
// The three-state `status` is not a design preference; it is what the machine
// does. Measured 2026-09-04 by putting two probes in a scratch project's
// .mcp.json and running `claude mcp list` twice:
//
//   no project entry          -> both "Pending approval"
//   one enabled, one disabled -> the enabled one connects, the disabled one is
//                                absent from the output entirely
//
// So a boolean cannot express what is on disk, and "disabled" is knowable only
// from configuration — which is why the inventory lists it rather than
// agreeing with the runtime.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { readMcpServers, readInventory, MCP_SCOPE } from './claude-config'

const TOKEN = 'claude-config-mcp-token'
const PRIVATE_MARKER = 'BUTTER_USERID_DO_NOT_SERVE'

/** A whole fake HOME: <base>/.claude plus the sibling <base>/.claude.json. */
interface Fixture {
  base: string
  home: string
  claudeJson: string
  repo: string
}

let fx: Fixture
let handle: CompanionServerHandle
let base: string

function makeFixture(opts: {
  projectKeys?: string[]
  enabled?: string[]
  disabled?: string[]
  mcpJson?: string | null
}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-mcp-'))
  const home = path.join(root, '.claude')
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo, { recursive: true })

  const projects: Record<string, unknown> = {}
  for (const key of opts.projectKeys ?? [repo]) {
    projects[key] = {
      allowedTools: [],
      enabledMcpjsonServers: opts.enabled ?? [],
      disabledMcpjsonServers: opts.disabled ?? []
    }
  }

  const claudeJson = path.join(root, '.claude.json')
  fs.writeFileSync(
    claudeJson,
    JSON.stringify({
      // The point of the projection: MCP is a minority of this file.
      userID: PRIVATE_MARKER,
      numStartups: 41,
      mcpServers: {
        'choda-tasks': { type: 'stdio', command: 'node' },
        playwright: { command: 'npx' }
      },
      projects
    }),
    'utf8'
  )

  if (opts.mcpJson !== null) {
    fs.writeFileSync(
      path.join(repo, '.mcp.json'),
      opts.mcpJson ??
        JSON.stringify({
          mcpServers: {
            'probe-alpha': { type: 'http', url: 'http://127.0.0.1:59999/mcp' },
            'probe-beta': { type: 'http', url: 'http://127.0.0.1:59998/mcp' }
          }
        }),
      'utf8'
    )
  }

  return { base: root, home, claudeJson, repo }
}

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => [],
  getWorkspace: async (id: string) =>
    id === 'main' ? { id: 'main', label: 'Main', cwd: fx.repo, projectId: 'p' } : null
} as unknown as BackendTaskService

function get(urlPath: string): Promise<{ status: number; body: string }> {
  return fetch(`${base}${urlPath}`, { headers: { 'x-choda-bridge-token': TOKEN } }).then(
    async (r) => ({ status: r.status, body: await r.text() })
  )
}

beforeAll(async () => {
  fx = makeFixture({ enabled: ['probe-alpha'], disabled: ['probe-beta'] })
  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    claudeHome: fx.home,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices
  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle?.close()
  fs.rmSync(fx.base, { recursive: true, force: true })
})

describe('AC-1 — the enable and disable lists mean what they say', () => {
  it('an enabled server is active and a disabled one is disabled', () => {
    const servers = readMcpServers(fx.home, fx.repo)
    const alpha = servers.find((s) => s.name === 'probe-alpha')
    const beta = servers.find((s) => s.name === 'probe-beta')
    expect(alpha?.status).toBe('active')
    expect(beta?.status).toBe('disabled')
    // The tell of a projection that ignores the lists: both agree.
    expect(alpha?.status).not.toBe(beta?.status)
  })
})

describe('AC-2 — a server in neither list is pending, not on or off', () => {
  it('reports pending when the project entry names it nowhere', () => {
    const f = makeFixture({ enabled: [], disabled: [] })
    const servers = readMcpServers(f.home, f.repo)
    expect(servers.find((s) => s.name === 'probe-alpha')?.status).toBe('pending')
    expect(servers.find((s) => s.name === 'probe-beta')?.status).toBe('pending')
    fs.rmSync(f.base, { recursive: true, force: true })
  })

  it('reports pending when the project has no entry in .claude.json at all', () => {
    const f = makeFixture({ projectKeys: ['C:/somewhere/else'] })
    expect(readMcpServers(f.home, f.repo).find((s) => s.name === 'probe-alpha')?.status).toBe(
      'pending'
    )
    fs.rmSync(f.base, { recursive: true, force: true })
  })
})

describe('AC-3 — a disabled server is listed, not omitted', () => {
  it('keeps the row that `claude mcp list` drops', () => {
    // The runtime answers "what is running". An inventory answers "what is
    // configured". Omitting the disabled row would silently switch questions.
    const servers = readMcpServers(fx.home, fx.repo)
    const project = servers.filter((s) => s.origin === 'project')
    expect(project).toHaveLength(2)
    expect(project.map((s) => s.name).sort()).toEqual(['probe-alpha', 'probe-beta'])
  })
})

describe('AC-4 — origin and source name where a server came from', () => {
  it('a repo-declared server is project-origin and points at the repo file', () => {
    const alpha = readMcpServers(fx.home, fx.repo).find((s) => s.name === 'probe-alpha')
    expect(alpha?.origin).toBe('project')
    expect(alpha?.source).toBe(path.join(fx.repo, '.mcp.json'))
    expect(alpha?.transport).toBe('http')
  })

  it('a globally declared server is global-origin and always active', () => {
    const globals = readMcpServers(fx.home, fx.repo).filter((s) => s.origin === 'global')
    expect(globals.map((s) => s.name).sort()).toEqual(['choda-tasks', 'playwright'])
    for (const g of globals) expect(g.status).toBe('active')
    // A server that omits `type` reports null rather than a guess.
    expect(globals.find((s) => s.name === 'playwright')?.transport).toBeNull()
  })
})

describe('AC-5 — a malformed .mcp.json degrades to one row', () => {
  it('names the parse error and leaves the global servers intact', () => {
    const f = makeFixture({ mcpJson: '{ "mcpServers": { broken' })
    const servers = readMcpServers(f.home, f.repo)
    const broken = servers.filter((s) => s.error !== null)
    expect(broken).toHaveLength(1)
    expect(broken[0].name).toBe('.mcp.json')
    expect(broken[0].error?.length).toBeGreaterThan(0)
    // The whole point: the rest of the answer survives.
    expect(servers.filter((s) => s.origin === 'global')).toHaveLength(2)
    fs.rmSync(f.base, { recursive: true, force: true })
  })
})

describe('AC-6 — project keys are matched as paths, not strings', () => {
  it('unions the lists across keys that resolve to the same directory', () => {
    // `<repo>` and `<repo>/` are the same directory written two ways: distinct
    // as strings, identical once resolved. Portable, and it fails against a
    // plain-string key lookup exactly as the case variant below does on Windows.
    // (An earlier attempt used path.join(repo, '.'), which normalises back to
    // repo — the two object keys collided and the fixture tested nothing.)
    const f = makeFixture({ projectKeys: [], enabled: [], disabled: [] })
    const raw = JSON.parse(fs.readFileSync(f.claudeJson, 'utf8'))
    raw.projects = {
      [f.repo]: { enabledMcpjsonServers: ['probe-alpha'], disabledMcpjsonServers: [] },
      [f.repo + path.sep]: { enabledMcpjsonServers: [], disabledMcpjsonServers: ['probe-beta'] }
    }
    fs.writeFileSync(f.claudeJson, JSON.stringify(raw), 'utf8')

    const servers = readMcpServers(f.home, f.repo)
    expect(servers.find((s) => s.name === 'probe-alpha')?.status).toBe('active')
    expect(servers.find((s) => s.name === 'probe-beta')?.status).toBe('disabled')
    fs.rmSync(f.base, { recursive: true, force: true })
  })

  it.skipIf(process.platform !== 'win32')(
    'unions the lists across keys differing only in drive-letter case',
    () => {
      // The real .claude.json carries both C:/dev/choda-deck and c:/dev/choda-deck.
      // Skipped off Windows because case-insensitive paths are the premise.
      const f = makeFixture({ projectKeys: [], enabled: [], disabled: [] })
      const raw = JSON.parse(fs.readFileSync(f.claudeJson, 'utf8'))
      const upper = f.repo
      const lower = f.repo.charAt(0).toLowerCase() + f.repo.slice(1)
      raw.projects = {
        [upper]: { enabledMcpjsonServers: ['probe-alpha'], disabledMcpjsonServers: [] },
        [lower.toUpperCase().charAt(0) === upper.charAt(0) ? lower : upper]: {
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: ['probe-beta']
        }
      }
      fs.writeFileSync(f.claudeJson, JSON.stringify(raw), 'utf8')

      const servers = readMcpServers(f.home, f.repo)
      expect(servers.find((s) => s.name === 'probe-alpha')?.status).toBe('active')
      expect(servers.find((s) => s.name === 'probe-beta')?.status).toBe('disabled')
      fs.rmSync(f.base, { recursive: true, force: true })
    }
  )
})

describe('AC-7 — .claude.json is never served as a file', () => {
  it('is unreachable under every published root id', async () => {
    for (const root of ['skills', 'commands', 'claude-md', 'plugin:anything']) {
      const res = await get(`/claude-config/${root}/../.claude.json`)
      expect([400, 403, 404]).toContain(res.status)
      expect(res.body).not.toContain(PRIVATE_MARKER)
    }
  })

  it('the projection carries the servers but not the rest of the file', async () => {
    const res = await get('/claude-config?workspaceId=main')
    expect(res.status).toBe(200)
    expect(res.body).toContain('choda-tasks')
    // userID, numStartups and the raw projects map share that document and must
    // not ride along on a route that only promised MCP servers.
    expect(res.body).not.toContain(PRIVATE_MARKER)
    expect(res.body).not.toContain('numStartups')
  })
})

describe('AC-8 — the answer states what it cannot see', () => {
  it('carries mcpScope with localOnly and a non-empty note', async () => {
    const body = JSON.parse((await get('/claude-config?workspaceId=main')).body)
    expect(body.mcpScope.localOnly).toBe(true)
    expect(body.mcpScope.note.length).toBeGreaterThan(0)
    expect(MCP_SCOPE.note).toContain('account-side')
  })
})

describe('the route wiring', () => {
  it('without workspaceId, answers with the global half only', async () => {
    const body = JSON.parse((await get('/claude-config')).body)
    expect(body.mcpServers.every((s: { origin: string }) => s.origin === 'global')).toBe(true)
    expect(body.mcpServers).toHaveLength(2)
  })

  it('404s on an unknown workspaceId, matching workspace-docs', async () => {
    const res = await get('/claude-config?workspaceId=nope')
    expect(res.status).toBe(404)
  })

  it('readInventory without a cwd still returns the mcp fields', () => {
    const inv = readInventory(fx.home)
    expect(inv.mcpScope.localOnly).toBe(true)
    expect(inv.mcpServers.every((s) => s.origin === 'global')).toBe(true)
  })
})
