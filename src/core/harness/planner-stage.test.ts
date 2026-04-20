import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { initSchema } from '../../tasks/repositories/schema'
import { SessionRepository } from '../../tasks/repositories/session-repository'
import { ConversationRepository } from '../../tasks/repositories/conversation-repository'
import { TaskRepository } from '../../tasks/repositories/task-repository'
import { RelationshipRepository } from '../../tasks/repositories/relationship-repository'
import { CounterRepository } from '../../tasks/repositories/counter-repository'
import { ProjectRepository } from '../../tasks/repositories/project-repository'
import { PipelineApprovalRepository } from '../../tasks/repositories/pipeline-approval-repository'
import { HarnessRunner } from './harness-runner'
import {
  extractAcceptanceCriteria,
  PlannerInvalidStageError,
  PlannerProjectMissingError,
  PlannerSessionMissingError,
  PlannerTaskMissingError,
  runPlannerStage
} from './planner-stage'
import {
  StageNonZeroExitError,
  StageTimeoutError,
  type StageRunResult,
  type StageRunOptions
} from './stage-runner'

const TEST_DB = path.join(__dirname, '__test-planner-stage__.db')

let db: Database.Database
let sessions: SessionRepository
let conversations: ConversationRepository
let tasks: TaskRepository
let projects: ProjectRepository
let approvals: PipelineApprovalRepository
let runner: HarnessRunner
let dataDir: string

const PROJECT_ID = 'proj-plan'
const WORKSPACE_CWD = '/tmp/ws-plan'

function makeTask(body: string | null = null): string {
  const t = tasks.create({ projectId: PROJECT_ID, title: 'Plan me' })
  if (body !== null) {
    tasks.update(t.id, { body })
  }
  return t.id
}

function okResult(resultJson: string): StageRunResult {
  return {
    parsed: {
      type: 'result',
      subtype: 'success',
      result: resultJson,
      total_cost_usd: 0.05,
      duration_ms: 1200
    },
    stdout: '',
    stderr: '',
    durationMs: 1200,
    totalCostUsd: 0.05,
    exitCode: 0
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)

  projects = new ProjectRepository(db)
  projects.ensure(PROJECT_ID, 'Planner Project', WORKSPACE_CWD)

  const relationships = new RelationshipRepository(db)
  const counters = new CounterRepository(db)
  sessions = new SessionRepository(db)
  conversations = new ConversationRepository(db)
  tasks = new TaskRepository(db, relationships, counters)
  approvals = new PipelineApprovalRepository(db)
  runner = new HarnessRunner({ sessions, conversations, tasks, approvals })

  dataDir = mkdtempSync(path.join(tmpdir(), 'choda-planner-'))
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  rmSync(dataDir, { recursive: true, force: true })
})

describe('extractAcceptanceCriteria', () => {
  it('returns [] when body is null or has no Acceptance section', () => {
    expect(extractAcceptanceCriteria(null)).toEqual([])
    expect(extractAcceptanceCriteria('# Task\n\nNo AC here')).toEqual([])
  })

  it('extracts checklist items from Acceptance section', () => {
    const body = `# Scope\n\nStuff\n\n## Acceptance\n\n- [ ] First AC\n- [ ] Second AC\n- [x] Third done\n\n## Out of scope\n\n- Something else`
    expect(extractAcceptanceCriteria(body)).toEqual(['First AC', 'Second AC', 'Third done'])
  })

  it('supports plain bullets (no checkboxes)', () => {
    const body = `## Acceptance Criteria\n\n- A\n- B\n`
    expect(extractAcceptanceCriteria(body)).toEqual(['A', 'B'])
  })

  it('stops at next heading of any depth', () => {
    const body = `## Acceptance\n\n- A\n- B\n\n### Notes\n\n- Ignore`
    expect(extractAcceptanceCriteria(body)).toEqual(['A', 'B'])
  })
})

describe('runPlannerStage — happy path', () => {
  it('runs Claude, parses JSON result, writes plan.json, marks stage ready', async () => {
    const taskId = makeTask('## Acceptance\n\n- [ ] First AC\n- [ ] Second AC\n')
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const plan = { files: [{ path: 'src/x.ts', action: 'create', why: 'new module' }] }
    const runStage = vi.fn<(opts: StageRunOptions) => Promise<StageRunResult>>(async () =>
      okResult(JSON.stringify(plan))
    )

    const result = await runPlannerStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      state.sessionId
    )

    expect(runStage).toHaveBeenCalledTimes(1)
    const runStageArg = runStage.mock.calls[0][0]
    expect(runStageArg.workspacePath).toBe(WORKSPACE_CWD)
    expect(runStageArg.model).toBe('claude-opus-4-7')
    expect(runStageArg.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(runStageArg.maxBudgetUsd).toBe(0.25)
    expect(runStageArg.timeoutMs).toBe(300_000)
    expect(runStageArg.prompt).toContain('First AC')

    expect(result.plan).toEqual(plan)
    expect(existsSync(result.artifactPath)).toBe(true)
    expect(JSON.parse(readFileSync(result.artifactPath, 'utf8'))).toEqual(plan)

    expect(runner.getState(state.sessionId)?.stageStatus).toBe('ready')
  })

  it('honors opts overrides (model, budget, timeout)', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const runStage = vi.fn(async () => okResult('{"files":[]}'))

    await runPlannerStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      state.sessionId,
      { model: 'claude-sonnet-4-6', maxBudgetUsd: 0.5, timeoutMs: 60_000 }
    )

    const arg = runStage.mock.calls[0][0]
    expect(arg.model).toBe('claude-sonnet-4-6')
    expect(arg.maxBudgetUsd).toBe(0.5)
    expect(arg.timeoutMs).toBe(60_000)
  })

  it('strips fenced code blocks from Claude output', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const plan = { files: [] }
    const runStage = vi.fn(async () =>
      okResult('```json\n' + JSON.stringify(plan) + '\n```')
    )

    const result = await runPlannerStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      state.sessionId
    )

    expect(result.plan).toEqual(plan)
  })

  it('overwrites plan.json on revision (re-run)', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(okResult('{"version":1}'))
      .mockResolvedValueOnce(okResult('{"version":2}'))

    await runPlannerStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      state.sessionId
    )
    runner.rejectStage(state.sessionId, 'redo please')
    const second = await runPlannerStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      state.sessionId
    )

    expect(JSON.parse(readFileSync(second.artifactPath, 'utf8'))).toEqual({ version: 2 })
  })
})

describe('runPlannerStage — failures', () => {
  it('throws PlannerSessionMissingError for unknown session', async () => {
    await expect(
      runPlannerStage(
        {
          tasks,
          projects,
          harness: runner,
          artifactsConfig: { dataDir },
          runStage: vi.fn()
        },
        'NO-SUCH-SESSION'
      )
    ).rejects.toBeInstanceOf(PlannerSessionMissingError)
  })

  it('throws PlannerInvalidStageError when session is not on plan stage', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    runner.markStageReady(state.sessionId)
    runner.approveStage(state.sessionId)

    await expect(
      runPlannerStage(
        {
          tasks,
          projects,
          harness: runner,
          artifactsConfig: { dataDir },
          runStage: vi.fn()
        },
        state.sessionId
      )
    ).rejects.toBeInstanceOf(PlannerInvalidStageError)
  })

  it('throws PlannerTaskMissingError when task row is gone', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    await expect(
      runPlannerStage(
        {
          tasks,
          projects,
          harness: runner,
          artifactsConfig: { dataDir },
          runStage: vi.fn()
        },
        state.sessionId
      )
    ).rejects.toBeInstanceOf(PlannerTaskMissingError)
  })

  it('throws PlannerProjectMissingError when project lookup returns null', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const nullProjects = { get: vi.fn(() => null) } as unknown as typeof projects

    await expect(
      runPlannerStage(
        {
          tasks,
          projects: nullProjects,
          harness: runner,
          artifactsConfig: { dataDir },
          runStage: vi.fn()
        },
        state.sessionId
      )
    ).rejects.toBeInstanceOf(PlannerProjectMissingError)
  })

  it('calls failStage with synthetic reason on timeout', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const runStage = vi.fn(async () => {
      throw new StageTimeoutError(300_000, 'hang')
    })

    await expect(
      runPlannerStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        state.sessionId
      )
    ).rejects.toBeInstanceOf(StageTimeoutError)

    const after = runner.getState(state.sessionId)
    expect(after?.stageStatus).toBe('rejected')
    expect(after?.currentIteration).toBe(1)

    const rows = db
      .prepare('SELECT decision, feedback FROM pipeline_approvals WHERE session_id = ?')
      .all(state.sessionId) as { decision: string; feedback: string }[]
    expect(rows[0].decision).toBe('reject')
    expect(rows[0].feedback).toMatch(/timeout/i)
  })

  it('calls failStage with synthetic reason on non-zero exit', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const runStage = vi.fn(async () => {
      throw new StageNonZeroExitError(1, 'bang')
    })

    await expect(
      runPlannerStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        state.sessionId
      )
    ).rejects.toBeInstanceOf(StageNonZeroExitError)

    expect(runner.getState(state.sessionId)?.stageStatus).toBe('rejected')
  })

  it('calls failStage when Claude returns non-JSON result content', async () => {
    const taskId = makeTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })
    const runStage = vi.fn(async () => okResult('this is not json'))

    await expect(
      runPlannerStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        state.sessionId
      )
    ).rejects.toThrow()

    expect(runner.getState(state.sessionId)?.stageStatus).toBe('rejected')
  })
})
