import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
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
  GeneratorInvalidStageError,
  GeneratorPlanMissingError,
  GeneratorProjectMissingError,
  GeneratorSessionMissingError,
  GeneratorStoppedError,
  GeneratorTaskMissingError,
  runGeneratorStage
} from './generator-stage'
import {
  StageNonZeroExitError,
  StageTimeoutError,
  type StageRunResult,
  type StageRunOptions
} from './stage-runner'
import { getSessionArtifactsDir } from './artifacts'

const TEST_DB = path.join(__dirname, '__test-generator-stage__.db')

let db: Database.Database
let sessions: SessionRepository
let conversations: ConversationRepository
let tasks: TaskRepository
let projects: ProjectRepository
let approvals: PipelineApprovalRepository
let runner: HarnessRunner
let dataDir: string

const PROJECT_ID = 'proj-gen'
const WORKSPACE_CWD = '/tmp/ws-gen'

function makeTaskAndSeedPlanStage(body: string | null = null): {
  taskId: string
  sessionId: string
} {
  const t = tasks.create({ projectId: PROJECT_ID, title: 'Generate me' })
  if (body !== null) tasks.update(t.id, { body })
  const state = runner.startPipeline(t.id, { evaluator: 'off' })
  return { taskId: t.id, sessionId: state.sessionId }
}

// Approve plan to land on stage='generate', status='running'. Seed plan.json.
function advanceToGenerate(
  sessionId: string,
  plan: Record<string, unknown> = { files: [] }
): void {
  runner.markStageReady(sessionId)
  runner.approveStage(sessionId)
  const dir = getSessionArtifactsDir({ dataDir }, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan), 'utf8')
}

function okResult(resultJson: string): StageRunResult {
  return {
    parsed: {
      type: 'result',
      subtype: 'success',
      result: resultJson,
      total_cost_usd: 0.42,
      duration_ms: 8_500
    },
    stdout: '',
    stderr: '',
    durationMs: 8_500,
    totalCostUsd: 0.42,
    exitCode: 0
  }
}

const GOOD_OUTPUT = {
  status: 'complete',
  stopReason: null,
  files: [{ path: 'src/foo.ts', action: 'edit' }],
  summary: 'Added foo()',
  diff: '```diff\n+ foo\n```'
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)

  projects = new ProjectRepository(db)
  projects.ensure(PROJECT_ID, 'Generator Project', WORKSPACE_CWD)

  const relationships = new RelationshipRepository(db)
  const counters = new CounterRepository(db)
  sessions = new SessionRepository(db)
  conversations = new ConversationRepository(db)
  tasks = new TaskRepository(db, relationships, counters)
  approvals = new PipelineApprovalRepository(db)
  runner = new HarnessRunner({ sessions, conversations, tasks, approvals })

  dataDir = mkdtempSync(path.join(tmpdir(), 'choda-generator-'))
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  rmSync(dataDir, { recursive: true, force: true })
})

describe('runGeneratorStage — happy path', () => {
  it('runs Claude, parses JSON output, writes generated.json + diff.md, marks stage ready', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId, { files: [{ path: 'src/foo.ts', action: 'edit', why: 'x' }] })

    const runStage = vi.fn<(opts: StageRunOptions) => Promise<StageRunResult>>(async () =>
      okResult(JSON.stringify(GOOD_OUTPUT))
    )

    const result = await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId
    )

    expect(runStage).toHaveBeenCalledTimes(1)
    const arg = runStage.mock.calls[0][0]
    expect(arg.workspacePath).toBe(WORKSPACE_CWD)
    expect(arg.model).toBe('claude-sonnet-4-6')
    expect(arg.tools).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'])
    expect(arg.allowedTools).toEqual(['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)'])
    expect(arg.maxBudgetUsd).toBe(1.0)
    expect(arg.timeoutMs).toBe(600_000)
    expect(arg.prompt).toContain('## Approved plan')
    expect(arg.prompt).toContain('src/foo.ts')

    expect(result.generated.status).toBe('complete')
    expect(result.generated.files).toEqual([{ path: 'src/foo.ts', action: 'edit' }])
    expect(existsSync(result.generatedPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(result.generatedPath, 'utf8'))
    expect(onDisk).not.toHaveProperty('diff')
    expect(onDisk.summary).toBe('Added foo()')

    expect(result.diffPath).not.toBeNull()
    expect(existsSync(result.diffPath as string)).toBe(true)
    expect(readFileSync(result.diffPath as string, 'utf8')).toContain('+ foo')

    expect(runner.getState(sessionId)?.stageStatus).toBe('ready')
  })

  it('honors opts overrides (model, budget, timeout) + forwards rejectionFeedback into prompt', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () => okResult(JSON.stringify(GOOD_OUTPUT)))

    await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId,
      {
        model: 'claude-opus-4-7',
        maxBudgetUsd: 2.5,
        timeoutMs: 120_000,
        rejectionFeedback: 'redo step 3'
      }
    )

    const arg = runStage.mock.calls[0][0]
    expect(arg.model).toBe('claude-opus-4-7')
    expect(arg.maxBudgetUsd).toBe(2.5)
    expect(arg.timeoutMs).toBe(120_000)
    expect(arg.prompt).toContain('Previous rejection feedback')
    expect(arg.prompt).toContain('redo step 3')
  })

  it('strips fenced code blocks from Claude output', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () =>
      okResult('```json\n' + JSON.stringify(GOOD_OUTPUT) + '\n```')
    )

    const result = await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId
    )

    expect(result.generated.status).toBe('complete')
  })

  it('skips diff.md when diff is empty', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () =>
      okResult(JSON.stringify({ ...GOOD_OUTPUT, diff: '' }))
    )

    const result = await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId
    )

    expect(result.diffPath).toBeNull()
    const dir = getSessionArtifactsDir({ dataDir }, sessionId)
    expect(existsSync(path.join(dir, 'diff.md'))).toBe(false)
  })

  it('overwrites generated.json + diff.md on revision (re-run)', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi
      .fn()
      .mockResolvedValueOnce(okResult(JSON.stringify({ ...GOOD_OUTPUT, summary: 'v1' })))
      .mockResolvedValueOnce(okResult(JSON.stringify({ ...GOOD_OUTPUT, summary: 'v2' })))

    await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId
    )
    runner.rejectStage(sessionId, 'try again')
    const second = await runGeneratorStage(
      { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
      sessionId
    )

    expect(JSON.parse(readFileSync(second.generatedPath, 'utf8')).summary).toBe('v2')
  })
})

describe('runGeneratorStage — stopped (strict mode)', () => {
  it('writes generated.json + throws GeneratorStoppedError when status=stopped', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () =>
      okResult(
        JSON.stringify({
          status: 'stopped',
          stopReason: 'plan step 2 references unknown module',
          files: [],
          summary: '',
          diff: ''
        })
      )
    )

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        sessionId
      )
    ).rejects.toBeInstanceOf(GeneratorStoppedError)

    const dir = getSessionArtifactsDir({ dataDir }, sessionId)
    expect(existsSync(path.join(dir, 'generated.json'))).toBe(true)
    expect(existsSync(path.join(dir, 'diff.md'))).toBe(false)

    const after = runner.getState(sessionId)
    expect(after?.stageStatus).toBe('rejected')
    expect(after?.currentIteration).toBe(1)

    const rows = db
      .prepare('SELECT decision, feedback FROM pipeline_approvals WHERE session_id = ? AND stage = ?')
      .all(sessionId, 'generate') as { decision: string; feedback: string }[]
    expect(rows.at(-1)?.decision).toBe('reject')
    expect(rows.at(-1)?.feedback).toMatch(/stopped/i)
  })
})

describe('runGeneratorStage — failures', () => {
  it('throws GeneratorSessionMissingError for unknown session', async () => {
    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage: vi.fn() },
        'NO-SUCH-SESSION'
      )
    ).rejects.toBeInstanceOf(GeneratorSessionMissingError)
  })

  it('throws GeneratorInvalidStageError when session is still on plan stage', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    // do NOT advance to generate — still on plan/running
    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage: vi.fn() },
        sessionId
      )
    ).rejects.toBeInstanceOf(GeneratorInvalidStageError)
  })

  it('throws GeneratorPlanMissingError when plan.json is absent', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    runner.markStageReady(sessionId)
    runner.approveStage(sessionId)
    // Do NOT write plan.json.

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage: vi.fn() },
        sessionId
      )
    ).rejects.toBeInstanceOf(GeneratorPlanMissingError)
  })

  it('throws GeneratorTaskMissingError when task row is gone', async () => {
    const { taskId, sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage: vi.fn() },
        sessionId
      )
    ).rejects.toBeInstanceOf(GeneratorTaskMissingError)
  })

  it('throws GeneratorProjectMissingError when project lookup returns null', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const nullProjects = { get: vi.fn(() => null) } as unknown as typeof projects

    await expect(
      runGeneratorStage(
        {
          tasks,
          projects: nullProjects,
          harness: runner,
          artifactsConfig: { dataDir },
          runStage: vi.fn()
        },
        sessionId
      )
    ).rejects.toBeInstanceOf(GeneratorProjectMissingError)
  })

  it('calls failStage with synthetic reason on timeout', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () => {
      throw new StageTimeoutError(600_000, {
        exitCode: -1,
        stdout: '',
        stderr: '',
        parsed: null,
        cmd: 'claude',
        env: {},
        workspacePath: WORKSPACE_CWD,
        durationMs: 600_000,
        timedOut: true
      })
    })

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        sessionId
      )
    ).rejects.toBeInstanceOf(StageTimeoutError)

    expect(runner.getState(sessionId)?.stageStatus).toBe('rejected')

    const rows = db
      .prepare('SELECT decision, feedback FROM pipeline_approvals WHERE session_id = ? AND stage = ?')
      .all(sessionId, 'generate') as { decision: string; feedback: string }[]
    expect(rows.at(-1)?.decision).toBe('reject')
    expect(rows.at(-1)?.feedback).toMatch(/timeout/i)
  })

  it('calls failStage with synthetic reason on non-zero exit', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () => {
      throw new StageNonZeroExitError(1, {
        exitCode: 1,
        stdout: '',
        stderr: 'bang',
        parsed: null,
        cmd: 'claude --test',
        env: {},
        workspacePath: '/tmp',
        durationMs: 5,
        timedOut: false
      })
    })

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        sessionId
      )
    ).rejects.toBeInstanceOf(StageNonZeroExitError)

    expect(runner.getState(sessionId)?.stageStatus).toBe('rejected')

    const dir = getSessionArtifactsDir({ dataDir }, sessionId)
    expect(existsSync(path.join(dir, 'generator-failure.json'))).toBe(true)
  })

  it('calls failStage when Claude returns non-JSON result content', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () => okResult('not json at all'))

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        sessionId
      )
    ).rejects.toThrow()

    expect(runner.getState(sessionId)?.stageStatus).toBe('rejected')
  })

  it('calls failStage when parsed output is missing required fields', async () => {
    const { sessionId } = makeTaskAndSeedPlanStage()
    advanceToGenerate(sessionId)
    const runStage = vi.fn(async () =>
      okResult(JSON.stringify({ status: 'invalid', files: [] }))
    )

    await expect(
      runGeneratorStage(
        { tasks, projects, harness: runner, artifactsConfig: { dataDir }, runStage },
        sessionId
      )
    ).rejects.toThrow()

    expect(runner.getState(sessionId)?.stageStatus).toBe('rejected')
  })
})
