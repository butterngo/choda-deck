import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { improveConfigFile } from '../../core/domain/improve/improve-config'
import companion from '../../core/domain/improve/__fixtures__/companion-improve.json'
import {
  handleImproveRoute,
  improveDir,
  resetActiveRuns,
  type RunHandle,
  type RunSpawner
} from './improve'

// TASK-2357 — the routes over real HTTP, a real SQLite service in a temp dir,
// and a fake spawner so no test ever launches Claude.

const TOKEN = 'tok'
let tmp: string
let cwd: string
let artifactsDir: string
let svc: SqliteTaskService
let server: Server
let base: string
let spawned: { ws: string; model: string }[]
let finish: ((code: number) => void)[]

const fakeSpawn: RunSpawner = ({ ws, model }) => {
  spawned.push({ ws, model })
  let exit: (code: number | null) => void = () => {}
  finish.push((code) => exit(code))
  const handle: RunHandle = { onExit: (cb) => (exit = cb) }
  return handle
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-route-'))
  cwd = path.join(tmp, 'repo')
  fs.mkdirSync(cwd)
  artifactsDir = path.join(tmp, 'artifacts')
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', cwd)
  await svc.addWorkspace('p', 'web', 'Web', cwd)
  await svc.addWorkspace('p', 'other', 'Other', cwd)
  spawned = []
  finish = []
  resetActiveRuns()
  server = createServer((req, res) => {
    handleImproveRoute(req, res, {
      svc,
      bridgeToken: TOKEN,
      artifactsDir,
      spawnRun: fakeSpawn
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418)
        res.end()
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function call(method: string, p: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${p}`, {
    method,
    headers: { 'x-choda-bridge-token': TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

describe('GET /improve/:ws', () => {
  it('a workspace with no config → 200, config null, no scorecards', async () => {
    const res = await call('GET', '/improve/web')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      config: null,
      scorecards: [],
      runs: [],
      proposals: []
    })
  })

  it('refuses a missing token and an unknown workspace', async () => {
    expect((await fetch(`${base}/improve/web`)).status).toBe(401)
    expect((await call('GET', '/improve/nope')).status).toBe(404)
  })
})

describe('PUT /improve/:ws/config', () => {
  it('an invalid body → 400 naming the field, file not written', async () => {
    const res = await call('PUT', '/improve/web/config', { ...companion, mode: 'x' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ field: 'mode' })
    expect(fs.existsSync(improveConfigFile(cwd))).toBe(false)
  })

  it('a valid body → 200 and the file on disk holds the new config', async () => {
    const res = await call('PUT', '/improve/web/config', { ...companion, mode: 'scheduled' })
    expect(res.status).toBe(200)
    const onDisk = JSON.parse(fs.readFileSync(improveConfigFile(cwd), 'utf8'))
    expect(onDisk.mode).toBe('scheduled')
    expect((await (await call('GET', '/improve/web')).json()).config.mode).toBe('scheduled')
  })
})

describe('GET /improve/:ws/screenshots/<file>', () => {
  it('a traversal → 400; a real PNG in the folder → 200 image/png', async () => {
    const dir = improveDir(artifactsDir, 'web')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'tasks-today.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(path.join(tmp, 'secret.png'), 'nope')

    const bad = await call('GET', '/improve/web/screenshots/..%2F..%2F..%2Fsecret.png')
    expect(bad.status).toBe(400)
    const ok = await call('GET', '/improve/web/screenshots/tasks-today.png')
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await ok.arrayBuffer())[1]).toBe(0x50)
  })
})

describe('POST /improve/:ws/run', () => {
  it('a second run for the same ws → 409; another ws → 202; done frees the slot', async () => {
    const first = await call('POST', '/improve/web/run')
    expect(first.status).toBe(202)
    const { runId } = (await first.json()) as { runId: string }
    expect((await call('POST', '/improve/web/run')).status).toBe(409)
    expect((await call('POST', '/improve/other/run')).status).toBe(202)
    expect(spawned.map((s) => s.ws)).toEqual(['web', 'other'])

    finish[0](0)
    const run = await (await call('GET', `/improve/web/runs/${runId}`)).json()
    expect(run).toMatchObject({ runId, exitCode: 0 })
    expect(run.endedAt).not.toBeNull()
    expect((await call('POST', '/improve/web/run')).status).toBe(202)
  })

  it('passes the config model to the run', async () => {
    await call('PUT', '/improve/web/config', { ...companion, model: 'opus' })
    await call('POST', '/improve/web/run')
    expect(spawned[0].model).toBe('opus')
  })
})

describe('proposals', () => {
  async function proposal(text: string): Promise<string> {
    return (await svc.createInbox({ projectId: 'p', content: `[improve:web] ${text}` })).id
  }

  it('reject stores the reason and the item leaves the raw inbox', async () => {
    const id = await proposal('Tighten the today list spacing')
    const res = await call('POST', `/improve/web/proposals/${id}/reject`, { reason: 'too dense' })
    expect(res.status).toBe(200)
    const rejected = JSON.parse(
      fs.readFileSync(path.join(improveDir(artifactsDir, 'web'), 'rejected.json'), 'utf8')
    )
    expect(rejected).toMatchObject([{ inboxId: id, reason: 'too dense' }])
    const raw = await svc.findInbox({ projectId: 'p', status: 'raw' })
    expect(raw.map((i) => i.id)).not.toContain(id)
    const overview = await (await call('GET', '/improve/web')).json()
    expect(overview.proposals).toEqual([])
  })

  it('reject without a reason → 400 and nothing changes', async () => {
    const id = await proposal('x')
    const res = await call('POST', `/improve/web/proposals/${id}/reject`, {})
    expect(res.status).toBe(400)
    expect((await svc.getInbox(id))?.status).toBe('raw')
  })

  it('approve converts the item into a task in the workspace project', async () => {
    const id = await proposal('Show task count in the tab label\nEvidence: …')
    const res = await call('POST', `/improve/web/proposals/${id}/approve`)
    expect(res.status).toBe(200)
    const { taskId } = (await res.json()) as { taskId: string }
    const task = await svc.getTask(taskId)
    expect(task).toMatchObject({ projectId: 'p', title: 'Show task count in the tab label' })
    expect((await svc.getInbox(id))?.status).toBe('converted')
  })

  it("approve carries the proposal's own checkboxes into the task Acceptance", async () => {
    const id = await proposal('Cut LCP\n- [ ] /tasks/today LCP < 1.5s on the next measure run')
    const { taskId } = (await (
      await call('POST', `/improve/web/proposals/${id}/approve`)
    ).json()) as {
      taskId: string
    }
    const body = (await svc.getTask(taskId))?.body ?? ''
    expect(body).toContain('## Acceptance\n- [ ] /tasks/today LCP < 1.5s on the next measure run')
  })

  it('an inbox item without this workspace tag is not a proposal → 404', async () => {
    const other = await svc.createInbox({ projectId: 'p', content: '[improve:other] nope' })
    expect((await call('POST', `/improve/web/proposals/${other.id}/approve`)).status).toBe(404)
  })
})
