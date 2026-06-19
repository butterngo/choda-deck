// TASK-1067 — append-only fold: decide/signoff are typed message turns; the
// conversation header (status/decisionSummary/signedOff) is folded from them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../sqlite-task-service'

const TEST_DB = path.join(__dirname, '__test-conversation-fold__.db')
let svc: SqliteTaskService

async function open(participants: string[]): Promise<string> {
  const conv = await svc.openConversation({
    projectId: 'proj-f',
    title: 'Design sync',
    createdBy: participants[0],
    participants: participants.map((name) => ({ name })),
    initialMessage: { content: 'kickoff' }
  })
  return conv.id
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('proj-f', 'Fold Project', '/tmp/f')
})

afterEach(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('conversation append-only fold (TASK-1067)', () => {
  it('decide appends a typed decision turn; header folds decisionSummary', async () => {
    const id = await open(['Butter', 'Claude'])
    await svc.decideConversation(id, { author: 'Butter', decision: 'Use Option A' })

    const msgs = await svc.getConversationMessages(id)
    const decision = msgs.find((m) => m.kind === 'decision')
    expect(decision?.content).toBe('Use Option A')

    const conv = await svc.getConversation(id)
    expect(conv?.decisionSummary).toBe('Use Option A')
    // not all participants signed off yet → still open
    expect(conv?.status).toBe('open')
  })

  it('signoff appends a typed signoff turn; consensus folds status to decided', async () => {
    const id = await open(['Butter', 'Claude'])
    await svc.decideConversation(id, { author: 'Butter', decision: 'Ship it' })
    await svc.signoffConversation(id, 'Butter')
    let conv = await svc.getConversation(id)
    expect(conv?.status).toBe('open') // Claude hasn't signed

    await svc.signoffConversation(id, 'Claude')
    conv = await svc.getConversation(id)
    expect(conv?.status).toBe('decided')
    expect(conv?.signedOff.sort()).toEqual(['Butter', 'Claude'])
    expect(conv?.decidedAt).not.toBeNull()

    const signoffs = (await svc.getConversationMessages(id)).filter((m) => m.kind === 'signoff')
    expect(signoffs).toHaveLength(2)
  })

  it('signoff is idempotent — a repeat does not append a second signoff turn', async () => {
    const id = await open(['Butter'])
    await svc.signoffConversation(id, 'Butter')
    await svc.signoffConversation(id, 'Butter')
    const signoffs = (await svc.getConversationMessages(id)).filter((m) => m.kind === 'signoff')
    expect(signoffs).toHaveLength(1)
  })

  it('solo participant: decided once the sole participant decides + signs off', async () => {
    const id = await open(['Butter'])
    await svc.decideConversation(id, { author: 'Butter', decision: 'Solo call' })
    expect((await svc.getConversation(id))?.status).toBe('open') // not signed yet
    await svc.signoffConversation(id, 'Butter')
    expect((await svc.getConversation(id))?.status).toBe('decided')
  })

  it('folds from participants_json when the conversation arrived via sync (no local participant rows)', async () => {
    // Simulate a synced skeleton: conversations row with participants_json set but
    // NO conversation_participants rows (the association table is not synced).
    const db = svc.syncDatabase
    db.prepare(
      `INSERT INTO conversations (id, project_id, title, created_by, participants_json)
       VALUES ('CONV-SYNCED', 'proj-f', 'Synced', 'Butter', '["Butter","Claude"]')`
    ).run()
    // Decision + one signoff arrive as synced message rows.
    await svc.addConversationMessage({ conversationId: 'CONV-SYNCED', authorName: 'Butter', content: 'Do X', kind: 'decision' })
    await svc.addConversationMessage({ conversationId: 'CONV-SYNCED', authorName: 'Butter', content: '', kind: 'signoff' })
    svc.recomputeConversationHeader('CONV-SYNCED')
    expect((await svc.getConversation('CONV-SYNCED'))?.status).toBe('open') // Claude still owed

    await svc.addConversationMessage({ conversationId: 'CONV-SYNCED', authorName: 'Claude', content: '', kind: 'signoff' })
    svc.recomputeConversationHeader('CONV-SYNCED')
    const conv = await svc.getConversation('CONV-SYNCED')
    expect(conv?.status).toBe('decided')
    expect(conv?.decisionSummary).toBe('Do X')
  })

  it('converges when a turn arrives out of band (simulated sync merge)', async () => {
    // Two participants; Butter decides + signs locally.
    const id = await open(['Butter', 'Claude'])
    await svc.decideConversation(id, { author: 'Butter', decision: 'Adopt fold' })
    await svc.signoffConversation(id, 'Butter')
    expect((await svc.getConversation(id))?.status).toBe('open')

    // Claude's signoff turn arrives from the other origin as a raw appended
    // message (what the sync apply path inserts), then the header is recomputed.
    await svc.addConversationMessage({
      conversationId: id,
      authorName: 'Claude',
      content: '',
      kind: 'signoff'
    })
    svc.recomputeConversationHeader(id)

    const conv = await svc.getConversation(id)
    expect(conv?.status).toBe('decided')
    expect(conv?.signedOff.sort()).toEqual(['Butter', 'Claude'])
  })
})
