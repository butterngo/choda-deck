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
