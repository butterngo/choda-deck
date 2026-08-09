// TASK-1621 — session_end must not auto-decide conversations that merely
// auto-linked to the session, and must never reuse the session's own
// `handoff.resumePoint` as a conversation's `decisionSummary`.
//
// The first test in this file is the AC-1 reproduction: it recreates the
// 2026-06-06 report (SESSION-1780729514359-28 sweeping CONV-1780742019407-11)
// against current `main` before anything is changed. It is kept as a
// regression guard afterwards, inverted to assert the fixed behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'

const TEST_DB = path.join(__dirname, '__test-session-end-sweep__.db')
let svc: SqliteTaskService

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-sweep', 'Sweep Project', '/tmp/sweep')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('session_end conversation sweep (TASK-1621)', () => {
  it('AC-2 — leaves an auto-linked conversation open with its summary untouched', async () => {
    // Repro shape: one active session, then an unrelated conversation opened
    // mid-session. `conversation_open` auto-links it (one-active-session rule),
    // which is what made the accidental sweep so easy.
    const started = await svc.startSession({ projectId: 'proj-sweep' })
    const conv = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'PublishResult.error contract',
      createdBy: 'Butter',
      initialMessage: { content: 'Does the BE populate error for all failure modes?' }
    })

    const links = await svc.getConversationLinks(conv.id)
    expect(links.some((l) => l.linkedType === 'session' && l.linkedId === started.session.id)).toBe(
      true
    )

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'TASK-1049 merged to master (cdd118e); fan-out now 500' }
    })

    expect(r.closedConversationIds).toEqual([])
    const after = await svc.getConversation(conv.id)
    expect(after?.status).toBe('open')
    expect(after?.decisionSummary).toBeNull()
    expect(after?.decidedAt).toBeNull()
  })

  it('AC-3 — closes only a conversation named explicitly, with its own summary', async () => {
    const started = await svc.startSession({ projectId: 'proj-sweep' })
    const target = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'The one we actually resolved',
      createdBy: 'Butter',
      initialMessage: { content: 'pick A or B?' }
    })
    const bystander = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'Still waiting on BE',
      createdBy: 'Butter',
      initialMessage: { content: 'unanswered' }
    })

    const r = await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'session resume point, must never land on a conversation' },
      closeConversations: [{ conversationId: target.id, decisionSummary: 'Went with A' }]
    })

    expect(r.closedConversationIds).toEqual([target.id])

    const closed = await svc.getConversation(target.id)
    expect(closed?.status).toBe('decided')
    expect(closed?.decisionSummary).toBe('Went with A')

    const open = await svc.getConversation(bystander.id)
    expect(open?.status).toBe('open')
    expect(open?.decisionSummary).toBeNull()
  })

  it('AC-3 — the close is a real decision turn, so the fold agrees with the header', async () => {
    // The pre-fix code wrote the header directly, leaving state no message
    // backed — any later recomputeHeader silently erased it. The close must go
    // through the append-only log (TASK-1067) instead.
    const started = await svc.startSession({ projectId: 'proj-sweep' })
    const conv = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'Decided properly',
      createdBy: 'Butter',
      initialMessage: { content: 'q' }
    })

    await svc.endSession(started.session.id, {
      handoff: { resumePoint: 'rp' },
      closeConversations: [{ conversationId: conv.id, decisionSummary: 'Ship option A' }]
    })

    svc.recomputeConversationHeader(conv.id)
    const after = await svc.getConversation(conv.id)
    expect(after?.status).toBe('decided')
    expect(after?.decisionSummary).toBe('Ship option A')
  })

  it('rejects a conversation that is not linked to the session', async () => {
    const started = await svc.startSession({ projectId: 'proj-sweep' })
    const other = await svc.startSession({ projectId: 'proj-sweep' })
    const conv = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'Belongs elsewhere',
      createdBy: 'Butter',
      sessionId: other.session.id,
      initialMessage: { content: 'q' }
    })

    await expect(
      svc.endSession(started.session.id, {
        handoff: { resumePoint: 'rp' },
        closeConversations: [{ conversationId: conv.id, decisionSummary: 'nope' }]
      })
    ).rejects.toThrow(/not linked/i)
  })
})

describe('conversation reopen (TASK-1621 AC-4)', () => {
  it('restores a directly-stamped conversation to open without re-stamping', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'Polluted by the old sweep',
      createdBy: 'Butter',
      initialMessage: { content: 'never answered' }
    })
    // Simulate the pre-fix damage: a header write with no backing decision turn.
    await svc.updateConversation(conv.id, {
      status: 'decided',
      decisionSummary: 'TASK-1049 merged to master (cdd118e)',
      decidedAt: new Date().toISOString()
    })
    expect((await svc.getConversation(conv.id))?.status).toBe('decided')

    const reopened = await svc.reopenConversation(conv.id)

    expect(reopened.status).toBe('open')
    expect(reopened.decisionSummary).toBeNull()
    expect(reopened.decidedAt).toBeNull()
  })

  it('refuses to reopen a conversation genuinely decided via a decision turn', async () => {
    const conv = await svc.openConversation({
      projectId: 'proj-sweep',
      title: 'Legitimately decided',
      createdBy: 'Butter',
      initialMessage: { content: 'q' }
    })
    await svc.decideConversation(conv.id, { author: 'Butter', decision: 'Go with B' })
    expect((await svc.getConversation(conv.id))?.status).toBe('decided')

    await expect(svc.reopenConversation(conv.id)).rejects.toThrow(/decision turn/i)
    expect((await svc.getConversation(conv.id))?.decisionSummary).toBe('Go with B')
  })
})
