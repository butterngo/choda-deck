// TASK-1994 — PUT /meetings/:id/files. One test per adapter acceptance criterion,
// over a real companion server with a temp vault and a temp git repository
// registered as a workspace, because the contract is which files land where and
// what did NOT get touched.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { startCompanionServer, COMPANION_BIND, type CompanionServerHandle } from './http-server'
import type { CompanionServices } from './service-factory'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

const TOKEN = 'meeting-files-test-token'

let root: string
let vaultDir: string
let repoDir: string
let artifactsDir: string
let handle: CompanionServerHandle
let base: string

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-meeting-files-'))
  artifactsDir = path.join(root, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })

  const svc = {
    listProjects: async () => [{ id: 'mantu' }],
    findWorkspaces: async (projectId: string) =>
      projectId === 'mantu'
        ? [{ id: 'abcv2', projectId: 'mantu', label: 'ABCV2', cwd: repoDirRef(), archivedAt: null }]
        : [],
    findTasks: async () => [],
    findInbox: async () => [],
    findConversations: async () => []
  } as unknown as BackendTaskService

  const services = {
    svc,
    db: null,
    dbPath: ':memory:',
    intervalMs: 30000,
    bridgeToken: TOKEN,
    artifactsDir,
    // A getter, so each test's fresh vault is the one the server writes into.
    get vaultDir() {
      return vaultDir
    },
    pull: async () => ({ upserted: 0, tombstoned: 0, cursor: 0 }),
    push: async () => ({ drained: 0, conflicts: 0, remaining: 0, reachable: true }),
    close: () => {}
  } as unknown as CompanionServices

  handle = await startCompanionServer(services, 0)
  base = `http://${COMPANION_BIND}:${handle.address.port}`
})

function repoDirRef(): string {
  return repoDir
}

afterAll(async () => {
  await handle.close()
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    /* temp dir */
  }
})

let counter = 0
beforeEach(() => {
  counter++
  vaultDir = path.join(root, `vault-${counter}`)
  repoDir = path.join(root, `repo-${counter}`)
  fs.mkdirSync(vaultDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n')
})

// ---- helpers --------------------------------------------------------------------

const TRANSCRIPT = '# Transcript\n\n[00:00:44] Them: Còn cái này là em chỉ quan tâm…\n'
const NOTE = '# Chị Kate — Assessment report\n\n## Quyết định\n'

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'mantu',
    workspaceId: null,
    date: '2026-09-17',
    slug: 'chi-kate',
    files: [
      { name: 'transcript.md', markdown: TRANSCRIPT },
      { name: 'note.md', markdown: NOTE }
    ],
    alsoRepo: false,
    keepOutOfGit: true,
    ...over
  }
}

async function put(payload: Record<string, unknown>): Promise<{ status: number; json: { written?: string[]; error?: string } }> {
  const r = await fetch(`${base}/meetings/m1/files`, {
    method: 'PUT',
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return { status: r.status, json: (await r.json()) as { written?: string[]; error?: string } }
}

/** A fingerprint of every path and file byte under a directory. */
function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.name === '.git') continue
      h.update(path.relative(dir, p))
      if (e.isDirectory()) walk(p)
      else h.update(fs.readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

const vaultFolder = (project = 'mantu', folder = '2026-09-17-chi-kate'): string =>
  path.join(vaultDir, '10-Projects', project, 'meetings', folder)
const repoFolder = (folder = '2026-09-17-chi-kate'): string => path.join(repoDir, 'docs', 'meetings', folder)

// ---- acceptance -----------------------------------------------------------------

describe('AC-1 — both files land in the vault, byte-exact', () => {
  it('201, two files, written lists exactly them', async () => {
    const r = await put(body())
    expect(r.status).toBe(201)
    const t = path.join(vaultFolder(), 'transcript.md')
    const n = path.join(vaultFolder(), 'note.md')
    expect(Buffer.compare(fs.readFileSync(t), Buffer.from(TRANSCRIPT, 'utf8'))).toBe(0)
    expect(Buffer.compare(fs.readFileSync(n), Buffer.from(NOTE, 'utf8'))).toBe(0)
    expect([...(r.json.written ?? [])].sort()).toEqual([n, t].sort())
  })
})

describe('AC-2 — alsoRepo writes the repo copy and git-ignores it exactly once', () => {
  it('vault + repo files, .gitignore line present once after two saves', async () => {
    const first = await put(body({ alsoRepo: true, workspaceId: 'abcv2' }))
    expect(first.status).toBe(201)
    const second = await put(body({ alsoRepo: true, workspaceId: 'abcv2', slug: 'chi-kate-2' }))
    expect(second.status).toBe(201)

    for (const name of ['transcript.md', 'note.md']) {
      expect(fs.existsSync(path.join(vaultFolder(), name))).toBe(true)
      expect(fs.existsSync(path.join(repoFolder(), name))).toBe(true)
      expect(fs.existsSync(path.join(repoFolder('2026-09-17-chi-kate-2'), name))).toBe(true)
    }
    const lines = fs.readFileSync(path.join(repoDir, '.gitignore'), 'utf8').split(/\r?\n/)
    expect(lines.filter((l) => l === 'docs/meetings/')).toHaveLength(1)
    // And git itself agrees the copy is not something to commit.
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repoDir }).toString()
    expect(status).not.toContain('docs/meetings')
  })
})

describe('AC-3 — without alsoRepo, the workspace is not touched', () => {
  it('repo tree hash is unchanged', async () => {
    const before = treeHash(repoDir)
    // workspaceId is set on purpose: the checkbox, not the picker, decides.
    const r = await put(body({ alsoRepo: false, workspaceId: 'abcv2' }))
    expect(r.status).toBe(201)
    expect(treeHash(repoDir)).toBe(before)
  })
})

describe('AC-4 — keepOutOfGit:false leaves .gitignore alone', () => {
  it('.gitignore bytes identical after a repo save', async () => {
    const gi = path.join(repoDir, '.gitignore')
    const before = fs.readFileSync(gi)
    const r = await put(body({ alsoRepo: true, workspaceId: 'abcv2', keepOutOfGit: false }))
    expect(r.status).toBe(201)
    expect(Buffer.compare(fs.readFileSync(gi), before)).toBe(0)
    expect(fs.existsSync(path.join(repoFolder(), 'note.md'))).toBe(true)
  })
})

describe('AC-5 — any existing target refuses the whole save', () => {
  it('note.md exists → 409 and transcript.md is not written', async () => {
    fs.mkdirSync(vaultFolder(), { recursive: true })
    fs.writeFileSync(path.join(vaultFolder(), 'note.md'), 'an earlier note\n')
    const r = await put(body())
    expect(r.status).toBe(409)
    expect(r.json.error).toBe('exists')
    expect(fs.existsSync(path.join(vaultFolder(), 'transcript.md'))).toBe(false)
    expect(fs.readFileSync(path.join(vaultFolder(), 'note.md'), 'utf8')).toBe('an earlier note\n')
  })
})

describe('AC-6 — traversal in slug or projectId is refused before any write', () => {
  it.each([
    ['slug', { slug: '../../20-Areas/goals' }],
    ['projectId', { projectId: '..' }]
  ])('bad %s → 400, vault and repo unchanged', async (_label, over) => {
    fs.mkdirSync(path.join(vaultDir, '20-Areas'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, '20-Areas', 'goals.md'), 'keep me\n')
    const vaultBefore = treeHash(vaultDir)
    const repoBefore = treeHash(repoDir)
    const r = await put(body({ ...over, alsoRepo: true, workspaceId: 'abcv2' }))
    expect(r.status).toBe(400)
    expect(treeHash(vaultDir)).toBe(vaultBefore)
    expect(treeHash(repoDir)).toBe(repoBefore)
  })
})

describe('AC-7 — an unregistered workspace writes nothing anywhere', () => {
  it('404, and not even the vault copy exists', async () => {
    const vaultBefore = treeHash(vaultDir)
    const repoBefore = treeHash(repoDir)
    const r = await put(body({ alsoRepo: true, workspaceId: 'not-registered' }))
    expect(r.status).toBe(404)
    expect(r.json.error).toBe('unknown workspace')
    expect(treeHash(vaultDir)).toBe(vaultBefore)
    expect(treeHash(repoDir)).toBe(repoBefore)
  })
})
