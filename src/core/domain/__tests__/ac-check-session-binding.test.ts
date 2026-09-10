import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import * as fs from 'fs'
import * as path from 'path'

// TASK-1577 — which session an ac_check is attributed to.
//
// The old resolver was `getActive(projectId, workspaceId)`, i.e.
// `ORDER BY started_at DESC LIMIT 1`. A workspace may legally hold several
// active sessions — session_start says so — so that silently picked whichever
// started last. On 2026-08-05 the tick landed on the right task and the
// ATTRIBUTION landed on a different agent's session; the response echoed that
// id, and passing it to session_end ended their session and flipped their task
// to IMPLEMENTED. The tick was never the damage. The echo was.

const TEST_DB = path.join(__dirname, '__test-ac-session__.db')
let svc: SqliteTaskService
let taskId = ''

const BODY = ['## Acceptance', '', '- [ ] first', '- [ ] second', ''].join('\n')

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('p', 'Project', '/tmp/p')
})

afterAll(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

beforeEach(async () => {
  // Every test starts from no active sessions and a fresh unticked body, so
  // one test's leftovers cannot make the next one pass.
  for (const s of await svc.findSessions('p', 'active')) {
    await svc.abandonSession(s.id, 'test cleanup')
  }
  const t = await svc.createTask({ projectId: 'p', title: 'subject', body: BODY })
  taskId = t.id
})

describe('ac_check session binding (TASK-1577)', () => {
  it('with ONE active session, nothing changes — no sessionId needed', async () => {
    const only = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    const r = await svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w' })
    expect(r.sessionId).toBe(only.id)
  })

  it('with TWO active sessions and no sessionId, it REFUSES and names both', async () => {
    const a = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    const b = await svc.createSession({ projectId: 'p', workspaceId: 'w' })

    await expect(
      svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w' })
    ).rejects.toMatchObject({ code: 'AMBIGUOUS_SESSION' })

    // Naming them is the point: an error that only says "ambiguous" leaves the
    // caller with no next move.
    await svc
      .checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w' })
      .catch((e: Error) => {
        expect(e.message).toContain(a.id)
        expect(e.message).toContain(b.id)
      })
  })

  it('does not bind to the NEWER of two — the old behaviour, asserted as absent', async () => {
    await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    const newer = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    let bound: string | null = null
    try {
      const r = await svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w' })
      bound = r.sessionId
    } catch {
      bound = null
    }
    expect(bound).not.toBe(newer.id)
    expect(bound).toBeNull()
  })

  it('a named sessionId is used verbatim — including the OLDER one', async () => {
    const older = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    const r = await svc.checkAcItem({
      taskId,
      acIndex: 0,
      evidence: 'e',
      workspaceId: 'w',
      sessionId: older.id
    })
    // If the resolver still preferred the newest, this is where it would show.
    expect(r.sessionId).toBe(older.id)
  })

  it('a named session in ANOTHER workspace is an error, not a substitution', async () => {
    const elsewhere = await svc.createSession({ projectId: 'p', workspaceId: 'other' })
    await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    await expect(
      svc.checkAcItem({
        taskId,
        acIndex: 0,
        evidence: 'e',
        workspaceId: 'w',
        sessionId: elsewhere.id
      })
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' })
  })

  it('a named session that is not active is an error', async () => {
    const s = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    await svc.abandonSession(s.id, 'done')
    const live = await svc.createSession({ projectId: 'p', workspaceId: 'w' })
    await expect(
      svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w', sessionId: s.id })
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' })
    // CONTROL — the live one still works, so the rejection is about THIS
    // session's state rather than the named-session path being broken.
    const ok = await svc.checkAcItem({
      taskId,
      acIndex: 0,
      evidence: 'e',
      workspaceId: 'w',
      sessionId: live.id
    })
    expect(ok.sessionId).toBe(live.id)
  })

  it('no active session at all still says NO_ACTIVE_SESSION, not ambiguous', async () => {
    await expect(
      svc.checkAcItem({ taskId, acIndex: 0, evidence: 'e', workspaceId: 'w' })
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_SESSION' })
  })
})

// The second half of the incident. Fixing the resolver stops a wrong id being
// PRODUCED; this stops a wrong id, however obtained, being ACTED ON.
describe('session_end expectTaskId (TASK-1577)', () => {
  const handoff = {
    commits: [],
    decisions: [],
    resumePoint: 'x',
    looseEnds: [],
    tasksUpdated: []
  }

  it('refuses to end a session bound to a different task', async () => {
    const mine = await svc.createTask({ projectId: 'p', title: 'mine' })
    const theirs = await svc.createTask({ projectId: 'p', title: 'theirs' })
    const s = await svc.startSession({ projectId: 'p', workspaceId: 'w', taskId: theirs.id })
    await expect(
      svc.endSession(s.session.id, { handoff, expectTaskId: mine.id })
    ).rejects.toMatchObject({ code: 'SESSION_MISMATCH' })

    // and the session is untouched — a refusal that half-ended it would be worse
    // than the bug.
    const after = await svc.getSession(s.session.id)
    expect(after?.status).toBe('active')
  })

  it('CONTROL — the right task ends it normally', async () => {
    const t = await svc.createTask({ projectId: 'p', title: 'right' })
    const s = await svc.startSession({ projectId: 'p', workspaceId: 'w', taskId: t.id })
    const r = await svc.endSession(s.session.id, { handoff, expectTaskId: t.id })
    expect(r.session.status).toBe('completed')
  })

  it('omitting expectTaskId keeps today behaviour — it is opt-in', async () => {
    const t = await svc.createTask({ projectId: 'p', title: 'no expectation' })
    const s = await svc.startSession({ projectId: 'p', workspaceId: 'w', taskId: t.id })
    const r = await svc.endSession(s.session.id, { handoff })
    expect(r.session.status).toBe('completed')
  })
})
