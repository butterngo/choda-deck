import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { handleInboxDecideRoute } from './inbox-decide'

// TASK-2380 — the decide-screen routes over real HTTP and a real SQLite service.

const TOKEN = 'tok'
let tmp: string
let svc: SqliteTaskService
let server: Server
let base: string

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-decide-'))
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', tmp)
  await svc.addWorkspace('p', 'web', 'Web', tmp)
  server = createServer((req, res) => {
    handleInboxDecideRoute(req, res, { svc, bridgeToken: TOKEN }).then((handled) => {
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

function call(method: string, p: string, body?: unknown, token = TOKEN): Promise<Response> {
  return fetch(base + p, {
    method,
    headers: {
      ...(token ? { 'x-choda-bridge-token': token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function seed(): Promise<Record<string, string>> {
  // The digest item is the OLDER one, so newest-first alone would put it
  // second: only the digest-first rule can put it on top.
  const digest = await svc.createInbox({
    projectId: 'p',
    content: '[activity-digest] Tuần 2026-W41: notify when a long turn ends\nWhy: waiting 45%'
  })
  await new Promise((r) => setTimeout(r, 5))
  const improve = await svc.createInbox({
    projectId: 'p',
    workspaceId: 'web',
    content:
      '[improve:web] Label the count column\nCriterion: UI scannable\n- [ ] count is labelled'
  })
  const oldDigest = await svc.createInbox({ projectId: 'p', content: '[activity-digest] old idea' })
  await svc.archiveInbox(oldDigest.id, 'done')
  const capture = await svc.createInbox({ projectId: 'p', content: 'buy milk' })
  return { improve: improve.id, digest: digest.id, oldDigest: oldDigest.id, capture: capture.id }
}

describe('GET /inbox/pending', () => {
  it('AC-1: only raw automated items, digest first, title without the tag', async () => {
    const ids = await seed()
    const res = await call('GET', '/inbox/pending')
    expect(res.status).toBe(200)
    const { items } = (await res.json()) as {
      items: { id: string; source: string; workspaceId: string | null; title: string }[]
    }
    // Digest above improve although the digest item is older; archived
    // digest and the untagged capture are absent.
    expect(items.map((i) => i.id)).toEqual([ids.digest, ids.improve])
    expect(items[0]).toMatchObject({
      source: 'activity-digest',
      title: 'Tuần 2026-W41: notify when a long turn ends'
    })
    expect(items[1]).toMatchObject({
      source: 'improve',
      workspaceId: 'web',
      title: 'Label the count column'
    })
  })
})

describe('POST /inbox/:id/convert', () => {
  it('AC-2: converts a pending item into a task carrying its text and checkboxes', async () => {
    const ids = await seed()
    const res = await call('POST', `/inbox/${ids.improve}/convert`)
    expect(res.status).toBe(200)
    const { taskId } = (await res.json()) as { taskId: string }
    const task = await svc.getTask(taskId)
    expect(task?.title).toBe('Label the count column')
    const body = task?.body ?? ''
    expect(body).toContain('## Context')
    expect(body).toContain('Criterion: UI scannable')
    expect(body).toContain('- [ ] count is labelled')
    expect((await svc.getInbox(ids.improve))?.status).toBe('converted')
  })

  it('AC-2: an untagged item is 404 and an already-decided one is 409', async () => {
    const ids = await seed()
    expect((await call('POST', `/inbox/${ids.capture}/convert`)).status).toBe(404)
    expect((await call('POST', `/inbox/${ids.oldDigest}/convert`)).status).toBe(409)
  })
})

describe('POST /inbox/:id/archive', () => {
  it('AC-3: archives with a reason; no reason is 400 and changes nothing', async () => {
    const ids = await seed()
    const bad = await call('POST', `/inbox/${ids.digest}/archive`, { reason: '  ' })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ field: 'reason' })
    expect((await call('POST', `/inbox/${ids.digest}/archive`, {})).status).toBe(400)
    expect((await svc.getInbox(ids.digest))?.status).toBe('raw')

    const ok = await call('POST', `/inbox/${ids.digest}/archive`, { reason: 'not now' })
    expect(ok.status).toBe(200)
    expect((await svc.getInbox(ids.digest))?.status).toBe('archived')
  })
})

describe('auth', () => {
  it('AC-4: all three routes return 401 without the bridge token', async () => {
    const ids = await seed()
    expect((await call('GET', '/inbox/pending', undefined, '')).status).toBe(401)
    expect((await call('POST', `/inbox/${ids.digest}/convert`, undefined, '')).status).toBe(401)
    expect((await call('POST', `/inbox/${ids.digest}/archive`, { reason: 'x' }, '')).status).toBe(
      401
    )
    expect((await svc.getInbox(ids.digest))?.status).toBe('raw')
  })

  it('leaves the plain GET /inbox to the generic handler', async () => {
    expect((await call('GET', '/inbox')).status).toBe(418)
  })
})
