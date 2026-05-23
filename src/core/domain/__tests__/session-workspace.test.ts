import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { SqliteTaskService } from '../sqlite-task-service'
import { loadLastSession } from '../../../adapters/mcp/mcp-tools/session-tools'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-session-ws__.db')
let svc: SqliteTaskService

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('ar', 'Automation Rule', '/tmp/ar')
})

afterAll(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('session per workspace', () => {
  it('creates session with workspaceId', async () => {
    const s = await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    expect(s.workspaceId).toBe('workflow-engine')
    expect(s.taskId).toBeNull()
    expect(s.status).toBe('active')
  })

  it('parallel sessions on different workspaces', async () => {
    const fe = await svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    expect(fe.workspaceId).toBe('remote-workflow')

    const beSess = await svc.getActiveSession('ar', 'workflow-engine')
    const feSess = await svc.getActiveSession('ar', 'remote-workflow')
    expect(beSess).not.toBeNull()
    expect(feSess).not.toBeNull()
    expect(beSess!.id).not.toBe(feSess!.id)
  })

  it('N parallel active sessions per workspace (TASK-526)', async () => {
    // Add 2 more on workflow-engine (already has 1 from test #1)
    await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })

    const all = (await svc.findSessions('ar', 'active')).filter((s) => s.workspaceId === 'workflow-engine')
    expect(all.length).toBe(3)
    expect(all.every((s) => s.status === 'active')).toBe(true)

    // cleanup so later tests start clean
    for (const s of all) await svc.updateSession(s.id, { status: 'completed', endedAt: '2026-04-19' })
    const fe = await svc.getActiveSession('ar', 'remote-workflow')
    if (fe) await svc.updateSession(fe.id, { status: 'completed', endedAt: '2026-04-19' })
  })

  it('loadLastSession scoped to workspace', async () => {
    const be = await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    await svc.updateSession(be.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'BE resume' }
    })

    const fe = await svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    await svc.updateSession(fe.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'FE resume' }
    })

    const beLast = await loadLastSession(svc, 'ar', 'workflow-engine')
    const feLast = await loadLastSession(svc, 'ar', 'remote-workflow')
    expect(beLast!.resumePoint).toBe('BE resume')
    expect(feLast!.resumePoint).toBe('FE resume')
  })

  it('loadLastSession deterministic when started_at ties (TASK-729)', async () => {
    // Force tied startedAt on two completed sessions for the same workspace.
    // Pre-fix: SQLite ORDER BY started_at DESC with no tiebreaker returned an
    // arbitrary row, so the .find() in loadLastSession could pick the older
    // session (with no handoff) → resumePoint=null. Repo now adds `rowid DESC`.
    const tied = '2026-04-20T00:00:00.000Z'
    const older = await svc.createSession({
      projectId: 'ar',
      workspaceId: 'tied-ws',
      startedAt: tied
    })
    await svc.updateSession(older.id, {
      status: 'completed',
      endedAt: '2026-04-20',
      handoff: { resumePoint: 'older' }
    })
    const newer = await svc.createSession({
      projectId: 'ar',
      workspaceId: 'tied-ws',
      startedAt: tied
    })
    await svc.updateSession(newer.id, {
      status: 'completed',
      endedAt: '2026-04-20',
      handoff: { resumePoint: 'newer' }
    })

    const last = await loadLastSession(svc, 'ar', 'tied-ws')
    expect(last!.id).toBe(newer.id)
    expect(last!.resumePoint).toBe('newer')
  })

  it('migration: legacy abandoned rows collapse to completed', async () => {
    // Use a separate fresh service to simulate a pre-migration DB
    const legacyDb = path.join(__dirname, '__test-legacy-sessions__.db')
    if (fs.existsSync(legacyDb)) fs.unlinkSync(legacyDb)

    // Seed a DB with the OLD schema (no CHECK), insert an 'abandoned' row, then re-open via SqliteTaskService
    // to trigger migrateSessionsStatus.
    const raw = new Database(legacyDb)
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL);
      INSERT INTO projects VALUES ('lp', 'Legacy', '/tmp/legacy');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace_id TEXT,
        task_id TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        handoff_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO sessions (id, project_id, started_at, status) VALUES
        ('S-OLD', 'lp', '2026-01-01', 'abandoned');
    `)
    raw.close()

    const migrated = new SqliteTaskService(legacyDb)
    const s = await migrated.getSession('S-OLD')
    expect(s?.status).toBe('completed')
    await migrated.close()
    fs.unlinkSync(legacyDb)
  })
})

describe('task binding (repository-level)', () => {
  it('binds task to session via updateSession', async () => {
    const task = await svc.createTask({ projectId: 'ar', title: 'TASK-105 test' })
    const s = await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })

    await svc.updateSession(s.id, { taskId: task.id })
    const updated = await svc.getSession(s.id)!
    expect(updated.taskId).toBe(task.id)
  })

  it('session_end with task marks task DONE', async () => {
    const task = await svc.createTask({ projectId: 'ar', title: 'TASK-106 test' })
    const s = await svc.createSession({ projectId: 'ar', workspaceId: 'remote-workflow' })
    await svc.updateSession(s.id, { taskId: task.id })
    await svc.updateTask(task.id, { status: 'IN-PROGRESS' })

    // simulate session_end
    await svc.updateTask(task.id, { status: 'DONE' })
    await svc.updateSession(s.id, {
      status: 'completed',
      endedAt: '2026-04-16',
      handoff: { resumePoint: 'done', tasksUpdated: [task.id] }
    })

    const finalTask = await svc.getTask(task.id)!
    const finalSession = await svc.getSession(s.id)!
    expect(finalTask.status).toBe('DONE')
    expect(finalSession.status).toBe('completed')
    expect(finalSession.handoff!.tasksUpdated).toContain(task.id)
  })

  it('WIP=1: session can only have 1 task', async () => {
    const s = await svc.createSession({ projectId: 'ar', workspaceId: 'workflow-engine' })
    const t1 = await svc.createTask({ projectId: 'ar', title: 'first' })
    await svc.updateSession(s.id, { taskId: t1.id })

    const session = await svc.getSession(s.id)!
    expect(session.taskId).toBe(t1.id)
    // Guard is in MCP tool layer, not repository — verify taskId is set
  })
})

