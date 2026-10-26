// TASK-2754 — GET /vault/search, one test per acceptance criterion.
//
// The 20-Areas case plants a word that exists nowhere else: a search that
// walked the whole vault would return it, so an empty result proves the root is
// the two readable folders rather than the vault.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { createAssistantReadServices } from './assistant-read-services'

const TOKEN = 'vault-search-test-token'
const PRIVATE_WORD = 'privateonlyword'

let vaultDir: string
let handle: CompanionServerHandle
let base: string

const fakeSvc = {
  listProjects: async () => [],
  findTasks: async () => [],
  findInbox: async () => [],
  findConversations: async () => [],
  findWorkspaces: async () => []
} as unknown as BackendTaskService

function get(urlPath: string, withToken = true): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = withToken ? { 'x-choda-bridge-token': TOKEN } : {}
  return fetch(`${base}${urlPath}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }))
}

beforeAll(async () => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-vault-search-'))
  const knowledge = path.join(vaultDir, '30-Knowledge')
  const projects = path.join(vaultDir, '10-Projects', 'ichiba-devops')
  const areas = path.join(vaultDir, '20-Areas')
  for (const d of [knowledge, projects, areas]) fs.mkdirSync(d, { recursive: true })

  fs.writeFileSync(path.join(knowledge, 'zebra-note.md'), '# Stripes\nA zebra has stripes.\n', 'utf8')
  fs.writeFileSync(path.join(areas, 'preferences.md'), `Butter likes ${PRIVATE_WORD}.\n`, 'utf8')
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(projects, `server-${i}.md`), `Server ${i} runs the gateway.\n`, 'utf8')
  }

  const services = {
    svc: fakeSvc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    vaultDir,
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

afterAll(async () => {
  await handle.close()
  try {
    fs.rmSync(vaultDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir; the OS reclaims it */
  }
})

describe('GET /vault/search', () => {
  it('AC-1: returns the one 30-Knowledge hit for a word only that note contains', async () => {
    const r = await get('/vault/search?q=zebra')
    expect(r.status).toBe(200)
    const hits = r.body as { path: string; snippet: string }[]
    expect(hits).toHaveLength(1)
    expect(hits[0].path.startsWith('30-Knowledge/')).toBe(true)
    expect(hits[0].snippet).toContain('zebra')
  })

  it('AC-2: a word present only under 20-Areas returns 200 []', async () => {
    const r = await get(`/vault/search?q=${PRIVATE_WORD}`)
    expect(r.status).toBe(200)
    expect(r.body).toEqual([])
    expect(JSON.stringify(r.body)).not.toContain(PRIVATE_WORD)
  })

  it('AC-3: no q returns 400 q is required', async () => {
    const r = await get('/vault/search')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'q is required' })
    const blank = await get('/vault/search?q=%20%20')
    expect(blank.status).toBe(400)
  })

  it('AC-4: no bridge token returns 401', async () => {
    const r = await get('/vault/search?q=zebra', false)
    expect(r.status).toBe(401)
  })

  it('AC-5: limit=2 with five matching notes returns exactly 2 hits', async () => {
    const all = await get('/vault/search?q=gateway')
    expect((all.body as unknown[]).length).toBe(5)
    const r = await get('/vault/search?q=gateway&limit=2')
    expect(r.status).toBe(200)
    expect(r.body as unknown[]).toHaveLength(2)
  })

  it('AC-6: the in-process searchVault and the route return the same hits', async () => {
    const reads = createAssistantReadServices({ svc: fakeSvc as never, vaultDir, store: null })
    for (const q of ['gateway', 'zebra', PRIVATE_WORD]) {
      const route = await get(`/vault/search?q=${q}&limit=10`)
      const inProcess = await reads.searchVault(q, 10)
      expect(route.body).toEqual(inProcess)
    }
  })
})
