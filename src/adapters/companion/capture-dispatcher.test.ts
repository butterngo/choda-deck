import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CompanionCaptureDispatcher } from './capture-dispatcher'
import { CaptureBadRequestError, type CaptureRequest } from './capture-contract'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'

function makeSvc(): BackendTaskService {
  return {
    createInbox: vi.fn(async () => ({ id: 'INBOX-1' })),
    createTask: vi.fn(async () => ({ id: 'TASK-9' })),
    openConversation: vi.fn(async () => ({ id: 'CONV-1' })),
    addConversationMessage: vi.fn(async () => ({ id: 'MSG-1', conversationId: 'CONV-7' })),
    createKnowledge: vi.fn(async () => ({ slug: 'adr-x' }))
  } as unknown as BackendTaskService
}

// 1x1 transparent PNG as a base64 data URL.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let ARTIFACTS: string
beforeEach(() => {
  ARTIFACTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-artifacts-'))
})
afterEach(() => {
  fs.rmSync(ARTIFACTS, { recursive: true, force: true })
})
const make = (svc: BackendTaskService): CompanionCaptureDispatcher =>
  new CompanionCaptureDispatcher(svc, ARTIFACTS)

const base = { kind: 'text' as const, sourceUrl: 'http://ex.com/p' }
const payload = { text: 'hello world', projectId: 'choda-deck' }

describe('CompanionCaptureDispatcher — text kind', () => {
  it('inbox → createInbox with source appended, returns inbox id', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch({
      ...base,
      destination: 'inbox',
      payload
    })
    expect(res).toEqual({ id: 'INBOX-1', destination: 'inbox' })
    expect(svc.createInbox).toHaveBeenCalledWith({
      projectId: 'choda-deck',
      content: 'hello world\n\nSource: http://ex.com/p'
    })
  })

  it('task → createTask with derived title + body, returns task id', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch({
      ...base,
      destination: 'task',
      payload: { ...payload, title: 'My title' }
    })
    expect(res).toEqual({ id: 'TASK-9', destination: 'task' })
    expect(svc.createTask).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'choda-deck', title: 'My title' })
    )
    const body = (svc.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0].body
    expect(body).toContain('Source: http://ex.com/p')
  })

  it('conversation (no id) → openConversation, returns new conversation id', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch({
      ...base,
      destination: 'conversation',
      payload
    })
    expect(res).toEqual({ id: 'CONV-1', destination: 'conversation' })
    expect(svc.openConversation).toHaveBeenCalled()
    expect(svc.addConversationMessage).not.toHaveBeenCalled()
  })

  it('conversation (with conversationId) → addConversationMessage reply, returns that thread id', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch({
      ...base,
      destination: 'conversation',
      payload: { ...payload, conversationId: 'CONV-42' }
    })
    expect(res).toEqual({ id: 'CONV-42', destination: 'conversation' })
    expect(svc.addConversationMessage).toHaveBeenCalledWith({
      conversationId: 'CONV-42',
      authorName: 'companion',
      content: 'hello world\n\nSource: http://ex.com/p'
    })
    expect(svc.openConversation).not.toHaveBeenCalled()
  })

  it('knowledge → createKnowledge (default type learning, project scope), returns slug', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch({
      ...base,
      destination: 'knowledge',
      payload
    })
    expect(res).toEqual({ id: 'adr-x', destination: 'knowledge' })
    expect(svc.createKnowledge).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'choda-deck', type: 'learning', scope: 'project', refs: [] })
    )
  })

  it('honors an explicit knowledgeType override', async () => {
    const svc = makeSvc()
    await make(svc).dispatch({
      ...base,
      destination: 'knowledge',
      payload: { ...payload, knowledgeType: 'gotcha' }
    })
    expect(svc.createKnowledge).toHaveBeenCalledWith(expect.objectContaining({ type: 'gotcha' }))
  })

  it.each([
    ['string payload (no projectId)', 'just text'],
    ['missing projectId', { text: 'hi' }],
    ['missing text', { projectId: 'choda-deck' }],
    ['empty text', { text: '', projectId: 'choda-deck' }]
  ])('throws CaptureBadRequestError on %s', async (_label, badPayload) => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch({
        ...base,
        destination: 'inbox',
        payload: badPayload
      })
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })

})

describe('CompanionCaptureDispatcher — image kind', () => {
  const imgReq = (destination: string, extra = {}): CaptureRequest =>
    ({
      kind: 'image',
      destination,
      sourceUrl: 'http://ex.com/p',
      payload: { dataUrl: PNG_DATA_URL, projectId: 'choda-deck', ...extra }
    }) as CaptureRequest

  it('decodes the data URL, writes a file under artifacts/captures, references it', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch(imgReq('knowledge'))
    expect(res.destination).toBe('knowledge')
    const captures = fs.readdirSync(path.join(ARTIFACTS, 'captures'))
    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatch(/\.png$/)
    const body = (svc.createKnowledge as ReturnType<typeof vi.fn>).mock.calls[0][0].body
    expect(body).toContain(captures[0])
  })

  it.each(['inbox', 'task'])('rejects the sync-eligible destination %s with 400', async (dest) => {
    const svc = makeSvc()
    await expect(make(svc).dispatch(imgReq(dest))).rejects.toBeInstanceOf(CaptureBadRequestError)
    // nothing written when the destination is rejected
    expect(fs.existsSync(path.join(ARTIFACTS, 'captures'))).toBe(false)
  })

  it.each([
    ['non-data-URL', 'https://x/y.png'],
    ['non-image mime', 'data:text/plain;base64,aGk='],
    ['non-string', 123]
  ])('rejects a bad image payload (%s)', async (_label, dataUrl) => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch(imgReq('conversation', { dataUrl }))
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })
})

describe('CompanionCaptureDispatcher — network kind', () => {
  const record = {
    method: 'GET',
    url: 'https://api.x/me',
    status: 200,
    responseHeaders: { 'content-type': 'application/json' },
    cookies: { session: 'abc' }
  }
  const netReq = (destination: string, rec: unknown = record): CaptureRequest =>
    ({
      kind: 'network',
      destination,
      sourceUrl: 'http://ex.com/p',
      payload: { record: rec, projectId: 'choda-deck' }
    }) as CaptureRequest

  it('persists a headers/cookies record into the entry body, no response body', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch(netReq('conversation'))
    expect(res.destination).toBe('conversation')
    const content = (svc.openConversation as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .initialMessage.content
    expect(content).toContain('GET https://api.x/me')
    expect(content).toContain('content-type')
    expect(content).toContain('session')
  })

  it.each(['inbox', 'task'])('rejects the sync-eligible destination %s with 400', async (dest) => {
    const svc = makeSvc()
    await expect(make(svc).dispatch(netReq(dest))).rejects.toBeInstanceOf(CaptureBadRequestError)
  })

  it('rejects a record missing method/url', async () => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch(netReq('knowledge', { url: 'https://x' }))
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })
})

describe('CompanionCaptureDispatcher — network-bundle kind (TASK-1372)', () => {
  const entries = [
    { method: 'GET', url: 'https://api.ex.com/a', status: 200, requestHeaders: { accept: '*/*' } },
    { method: 'POST', url: 'https://api.ex.com/b', status: 201, body: '{"ok":true}' },
    { method: 'GET', url: 'https://ex.com/app.js', status: 200 }
  ]
  const bundleReq = (destination: 'inbox' | 'task' | 'conversation' | 'knowledge', payload: unknown): CaptureRequest => ({
    kind: 'network-bundle',
    destination,
    sourceUrl: 'http://ex.com/p',
    payload
  })

  it('writes exactly ONE valid HAR 1.2 file and ONE conversation row linking it', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch(
      bundleReq('conversation', { entries, projectId: 'choda-deck' })
    )
    expect(res).toEqual({ id: 'CONV-1', destination: 'conversation' })

    const dir = path.join(ARTIFACTS, 'captures')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.har'))
    expect(files).toHaveLength(1)

    const har = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
    expect(har.log.version).toBe('1.2')
    expect(har.log.creator.name).toBe('choda-capture')
    expect(har.log.entries).toHaveLength(3)
    expect(har.log.entries[0].request.method).toBe('GET')
    expect(har.log.entries[1].response.content.text).toBe('{"ok":true}')

    expect(svc.openConversation).toHaveBeenCalledTimes(1)
    const call = (svc.openConversation as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.initialMessage.content).toContain(files[0])
    expect(call.initialMessage.content).toContain('3 requests')
  })

  it('empty entries → CaptureBadRequestError (400)', async () => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch(bundleReq('conversation', { entries: [], projectId: 'choda-deck' }))
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })

  it('inbox destination → guarded 400 (local-only)', async () => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch(bundleReq('inbox', { entries, projectId: 'choda-deck' }))
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })

  it('malformed entry (missing url) → CaptureBadRequestError', async () => {
    const svc = makeSvc()
    await expect(
      make(svc).dispatch(
        bundleReq('knowledge', { entries: [{ method: 'GET' }], projectId: 'choda-deck' })
      )
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })
})

describe('CompanionCaptureDispatcher — discovery-session kind (TASK-1410)', () => {
  const events = [
    { type: 'nav', ts: 1, url: 'https://shop.ex/products', title: 'Products' },
    { type: 'click', ts: 2, url: 'https://shop.ex/products', selector: '[data-testid=add]', text: 'Add to cart' },
    { type: 'apicall', ts: 3, url: 'https://api.ex/cart', method: 'POST', status: 201 },
    { type: 'snapshot', ts: 4, url: 'https://shop.ex/cart', snapshotId: 's1' }
  ]
  const SECRET = 'SUPERSECRET_TOKEN_abc123'
  const snapshots = [{ id: 's1', html: `<div data-token="${SECRET}">cart</div>`, css: 'div{color:red}' }]
  const discReq = (
    destination: 'inbox' | 'task' | 'conversation' | 'knowledge',
    payload: unknown
  ): CaptureRequest => ({
    kind: 'discovery-session',
    destination,
    sourceUrl: 'http://shop.ex/products',
    payload
  })

  it('writes timeline.jsonl (one event per line) + draft.md, returns inbox id (AC-2)', async () => {
    const svc = makeSvc()
    const res = await make(svc).dispatch(discReq('inbox', { events, snapshots, projectId: 'choda-deck' }))
    expect(res).toEqual({ id: 'INBOX-1', destination: 'inbox' })

    const capturesDir = path.join(ARTIFACTS, 'captures')
    const sessionDir = fs.readdirSync(capturesDir).find((d) => d.startsWith('discovery-'))
    expect(sessionDir).toBeDefined()
    const dir = path.join(capturesDir, sessionDir as string)

    const jsonl = fs.readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8').trimEnd()
    const lines = jsonl.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines.every((l) => JSON.parse(l).type)).toBe(true)

    const draft = fs.readFileSync(path.join(dir, 'draft.md'), 'utf8')
    expect(draft).toContain('# Discovery session')
    expect(draft).toContain('POST')
    // snapshot html + css written under snapshots/
    expect(fs.existsSync(path.join(dir, 'snapshots', 's1.html'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'snapshots', 's1.css'))).toBe(true)
  })

  it('persists an apicall event with a response body + reflects it in the draft (TASK-1419)', async () => {
    const svc = makeSvc()
    const withApi = [
      { type: 'nav', ts: 1, url: 'https://shop.ex/products', title: 'Products' },
      { type: 'apicall', ts: 2, url: 'https://api.ex/paging', method: 'POST', status: 200, body: '{"total":64537}' }
    ]
    await make(svc).dispatch(discReq('inbox', { events: withApi, projectId: 'choda-deck' }))
    const capturesDir = path.join(ARTIFACTS, 'captures')
    const dir = path.join(capturesDir, fs.readdirSync(capturesDir).find((d) => d.startsWith('discovery-')) as string)
    const jsonl = fs.readFileSync(path.join(dir, 'timeline.jsonl'), 'utf8')
    const apiLine = JSON.parse(jsonl.trimEnd().split('\n').find((l) => l.includes('apicall')) as string)
    expect(apiLine).toMatchObject({ type: 'apicall', method: 'POST', status: 200, body: '{"total":64537}' })
    const draft = fs.readFileSync(path.join(dir, 'draft.md'), 'utf8')
    expect(draft).toContain('api POST https://api.ex/paging → 200')
    expect(draft).toContain('body 15b')
  })

  it('inbox row carries a summary + relative pointer, NOT raw HTML bodies (AC-3)', async () => {
    const svc = makeSvc()
    await make(svc).dispatch(discReq('inbox', { events, snapshots, projectId: 'choda-deck' }))
    const content = (svc.createInbox as ReturnType<typeof vi.fn>).mock.calls[0][0].content as string
    expect(content).toContain('Discovery session')
    expect(content).toContain('timeline.jsonl')
    expect(content).toMatch(/captures\/discovery-[0-9a-f]+/)
    // the secret buried in the snapshot HTML must never reach the synced inbox row
    expect(content).not.toContain(SECRET)
    expect(content).not.toContain('<div')
  })

  it.each(['task', 'conversation', 'knowledge'] as const)(
    'destination %s → guarded 400 (inbox-only, AC-4)',
    async (dest) => {
      const svc = makeSvc()
      await expect(
        make(svc).dispatch(discReq(dest, { events, projectId: 'choda-deck' }))
      ).rejects.toBeInstanceOf(CaptureBadRequestError)
      expect(svc.createInbox).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['empty events', { events: [], projectId: 'choda-deck' }],
    ['missing projectId', { events }],
    ['event missing selector', { events: [{ type: 'click', ts: 1 }], projectId: 'choda-deck' }],
    ['bad event type', { events: [{ type: 'scroll', ts: 1 }], projectId: 'choda-deck' }]
  ])('rejects %s with 400', async (_label, payload) => {
    const svc = makeSvc()
    await expect(make(svc).dispatch(discReq('inbox', payload))).rejects.toBeInstanceOf(
      CaptureBadRequestError
    )
  })
})
