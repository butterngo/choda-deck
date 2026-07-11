import { describe, it, expect, vi } from 'vitest'
import { CompanionCaptureDispatcher } from './capture-dispatcher'
import {
  CaptureBadRequestError,
  UnimplementedKindError,
  type CaptureRequest
} from './capture-contract'
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

const base = { kind: 'text' as const, sourceUrl: 'http://ex.com/p' }
const payload = { text: 'hello world', projectId: 'choda-deck' }

describe('CompanionCaptureDispatcher — text kind', () => {
  it('inbox → createInbox with source appended, returns inbox id', async () => {
    const svc = makeSvc()
    const res = await new CompanionCaptureDispatcher(svc).dispatch({
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
    const res = await new CompanionCaptureDispatcher(svc).dispatch({
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
    const res = await new CompanionCaptureDispatcher(svc).dispatch({
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
    const res = await new CompanionCaptureDispatcher(svc).dispatch({
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
    const res = await new CompanionCaptureDispatcher(svc).dispatch({
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
    await new CompanionCaptureDispatcher(svc).dispatch({
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
      new CompanionCaptureDispatcher(svc).dispatch({
        ...base,
        destination: 'inbox',
        payload: badPayload
      })
    ).rejects.toBeInstanceOf(CaptureBadRequestError)
  })

  it.each(['image', 'network'] as const)('throws UnimplementedKindError on %s kind', async (kind) => {
    const svc = makeSvc()
    await expect(
      new CompanionCaptureDispatcher(svc).dispatch({
        kind,
        destination: 'knowledge',
        sourceUrl: 'http://x',
        payload
      } as CaptureRequest)
    ).rejects.toBeInstanceOf(UnimplementedKindError)
  })
})
