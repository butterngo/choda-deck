import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { initSchema } from '../../tasks/repositories/schema'
import { SessionRepository } from '../../tasks/repositories/session-repository'
import { ConversationRepository } from '../../tasks/repositories/conversation-repository'
import { TaskRepository } from '../../tasks/repositories/task-repository'
import { RelationshipRepository } from '../../tasks/repositories/relationship-repository'
import { CounterRepository } from '../../tasks/repositories/counter-repository'
import { ProjectRepository } from '../../tasks/repositories/project-repository'
import { PipelineApprovalRepository } from '../../tasks/repositories/pipeline-approval-repository'
import { HarnessRunner, MAX_CONCURRENT_SESSIONS } from './harness-runner'
import {
  InteractiveConversationBlockingError,
  InvalidPipelineTransitionError,
  PipelineCapExceededError,
  PipelineSessionNotFoundError,
  TaskNotFoundError
} from './errors'

const TEST_DB = path.join(__dirname, '__test-harness-runner__.db')
let db: Database.Database
let runner: HarnessRunner
let sessions: SessionRepository
let conversations: ConversationRepository
let tasks: TaskRepository
let approvals: PipelineApprovalRepository

function createTask(projectId = 'proj-h'): string {
  const task = tasks.create({ projectId, title: 'Do X' })
  return task.id
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  db = new Database(TEST_DB)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)

  const projects = new ProjectRepository(db)
  projects.ensure('proj-h', 'Harness Project', '/tmp/h')

  const relationships = new RelationshipRepository(db)
  const counters = new CounterRepository(db)
  sessions = new SessionRepository(db)
  conversations = new ConversationRepository(db)
  tasks = new TaskRepository(db, relationships, counters)
  approvals = new PipelineApprovalRepository(db)

  runner = new HarnessRunner({ sessions, conversations, tasks, approvals })
})

afterEach(() => {
  db.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('startPipeline', () => {
  it('creates session row + in-memory state at plan/running', () => {
    const taskId = createTask()
    const state = runner.startPipeline(taskId, { evaluator: 'off' })

    expect(state.stage).toBe('plan')
    expect(state.stageStatus).toBe('running')
    expect(state.needsEvaluator).toBe(false)
    expect(state.currentIteration).toBe(0)

    const persisted = sessions.get(state.sessionId)
    expect(persisted?.taskId).toBe(taskId)
    expect(persisted?.status).toBe('active')
  })

  it('persists pipeline_stage + pipeline_stage_status to DB', () => {
    const taskId = createTask()
    const state = runner.startPipeline(taskId, { evaluator: 'on' })

    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(state.sessionId) as Record<
      string,
      unknown
    >
    expect(row.pipeline_stage).toBe('plan')
    expect(row.pipeline_stage_status).toBe('running')
    expect(row.needs_evaluator).toBe(1)
  })

  it('resolves evaluator=on to needsEvaluator=true', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'on' })
    expect(state.needsEvaluator).toBe(true)
  })

  it('resolves evaluator=off to needsEvaluator=false', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    expect(state.needsEvaluator).toBe(false)
  })

  it('throws TaskNotFoundError on missing task', () => {
    expect(() => runner.startPipeline('TASK-999', { evaluator: 'off' })).toThrowError(
      TaskNotFoundError
    )
  })

  it('enforces MAX_CONCURRENT_SESSIONS cap', () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      runner.startPipeline(createTask(), { evaluator: 'off' })
    }
    expect(() => runner.startPipeline(createTask(), { evaluator: 'off' })).toThrowError(
      PipelineCapExceededError
    )
  })
})

describe('R3 reverse direction guard', () => {
  it('rejects start when interactive conversation is open', () => {
    const taskId = createTask()
    const session = sessions.create({
      projectId: 'proj-h',
      taskId: 'OTHER-TASK',
      status: 'active',
      startedAt: new Date().toISOString()
    })
    const conv = conversations.create({
      projectId: 'proj-h',
      title: 'Butter chat',
      createdBy: 'Butter',
      status: 'open'
    })
    db.prepare(
      "UPDATE conversations SET owner_type = 'interactive', owner_session_id = ? WHERE id = ?"
    ).run(session.id, conv.id)

    try {
      runner.startPipeline(taskId, { evaluator: 'off' })
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(InteractiveConversationBlockingError)
      const err = e as InteractiveConversationBlockingError
      expect(err.payload.owner_type).toBe('interactive')
      expect(err.payload.owner_session_id).toBe(session.id)
      expect(err.payload.owner_task_id).toBe('OTHER-TASK')
    }
  })

  it('ignores closed interactive conversations', () => {
    const taskId = createTask()
    const conv = conversations.create({
      projectId: 'proj-h',
      title: 'Old chat',
      createdBy: 'Butter',
      status: 'open'
    })
    db.prepare(
      "UPDATE conversations SET owner_type = 'interactive', status = 'closed' WHERE id = ?"
    ).run(conv.id)

    expect(() => runner.startPipeline(taskId, { evaluator: 'off' })).not.toThrow()
  })

  it('ignores pipeline-owned conversations (only interactive blocks)', () => {
    const taskId = createTask()
    const conv = conversations.create({
      projectId: 'proj-h',
      title: 'Pipeline chat',
      createdBy: 'Claude',
      status: 'open'
    })
    db.prepare("UPDATE conversations SET owner_type = 'pipeline' WHERE id = ?").run(conv.id)

    expect(() => runner.startPipeline(taskId, { evaluator: 'off' })).not.toThrow()
  })
})

describe('markStageReady', () => {
  it('flips running → ready + persists to DB', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    const after = runner.markStageReady(state.sessionId)
    expect(after.stageStatus).toBe('ready')

    const row = db.prepare('SELECT pipeline_stage_status FROM sessions WHERE id = ?').get(
      state.sessionId
    ) as { pipeline_stage_status: string }
    expect(row.pipeline_stage_status).toBe('ready')
  })

  it('throws when already ready', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    runner.markStageReady(state.sessionId)
    expect(() => runner.markStageReady(state.sessionId)).toThrowError(
      InvalidPipelineTransitionError
    )
  })
})

describe('approveStage state transitions', () => {
  it('plan/ready → generate/running', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    setReady(state.sessionId)

    const after = runner.approveStage(state.sessionId)
    expect(after.stage).toBe('generate')
    expect(after.stageStatus).toBe('running')
    expect(after.currentIteration).toBe(0)
  })

  it('generate/ready → evaluate/running when needsEvaluator=true', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'on' })
    setReady(state.sessionId)
    runner.approveStage(state.sessionId)
    setReady(state.sessionId)

    const after = runner.approveStage(state.sessionId)
    expect(after.stage).toBe('evaluate')
    expect(after.stageStatus).toBe('running')
  })

  it('generate/ready → done/null when needsEvaluator=false', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    setReady(state.sessionId)
    runner.approveStage(state.sessionId)
    setReady(state.sessionId)

    const after = runner.approveStage(state.sessionId)
    expect(after.stage).toBe('done')
    expect(after.stageStatus).toBeNull()
    expect(runner.getState(state.sessionId)).toBeNull()
  })

  it('evaluate/ready → done/null', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'on' })
    setReady(state.sessionId)
    runner.approveStage(state.sessionId)
    setReady(state.sessionId)
    runner.approveStage(state.sessionId)
    setReady(state.sessionId)

    const after = runner.approveStage(state.sessionId)
    expect(after.stage).toBe('done')
    expect(after.stageStatus).toBeNull()
  })

  it('throws InvalidPipelineTransitionError when status is running', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    expect(() => runner.approveStage(state.sessionId)).toThrowError(
      InvalidPipelineTransitionError
    )
  })

  it('logs approval row with decision=approve', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    setReady(state.sessionId)
    runner.approveStage(state.sessionId)

    const logged = approvals.findBySession(state.sessionId)
    expect(logged).toHaveLength(1)
    expect(logged[0].decision).toBe('approve')
    expect(logged[0].stage).toBe('plan')
  })
})

describe('rejectStage', () => {
  it('status ready → rejected, iteration bumps', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    setReady(state.sessionId)

    const after = runner.rejectStage(state.sessionId, 'plan is vague')
    expect(after.stage).toBe('plan')
    expect(after.stageStatus).toBe('rejected')
    expect(after.currentIteration).toBe(1)
  })

  it('logs approval row with feedback', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    setReady(state.sessionId)
    runner.rejectStage(state.sessionId, 'need more detail')

    const logged = approvals.findBySession(state.sessionId)
    expect(logged).toHaveLength(1)
    expect(logged[0].decision).toBe('reject')
    expect(logged[0].feedback).toBe('need more detail')
  })

  it('throws on running status', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    expect(() => runner.rejectStage(state.sessionId, 'x')).toThrowError(
      InvalidPipelineTransitionError
    )
  })
})

describe('failStage', () => {
  it('flips running → rejected + bumps iteration + logs reject w/ feedback', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })

    const after = runner.failStage(state.sessionId, '[planner timeout after 300000ms]')
    expect(after.stageStatus).toBe('rejected')
    expect(after.currentIteration).toBe(1)

    const logged = approvals.findBySession(state.sessionId)
    expect(logged).toHaveLength(1)
    expect(logged[0].decision).toBe('reject')
    expect(logged[0].feedback).toBe('[planner timeout after 300000ms]')
  })

  it('throws when status is not running', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    runner.markStageReady(state.sessionId)
    expect(() => runner.failStage(state.sessionId, 'x')).toThrowError(
      InvalidPipelineTransitionError
    )
  })
})

describe('abort', () => {
  it('any non-terminal stage → aborted/null', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    const after = runner.abort(state.sessionId)
    expect(after.stage).toBe('aborted')
    expect(after.stageStatus).toBeNull()
    expect(runner.getState(state.sessionId)).toBeNull()
  })

  it('logs abort decision', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    runner.abort(state.sessionId)

    const logged = approvals.findBySession(state.sessionId)
    expect(logged).toHaveLength(1)
    expect(logged[0].decision).toBe('abort')
  })

  it('frees a slot for new pipeline after abort', () => {
    const ids = Array.from({ length: MAX_CONCURRENT_SESSIONS }, () =>
      runner.startPipeline(createTask(), { evaluator: 'off' })
    )
    runner.abort(ids[0].sessionId)
    expect(() => runner.startPipeline(createTask(), { evaluator: 'off' })).not.toThrow()
  })
})

describe('lookup + hydration', () => {
  it('getState returns null for unknown session', () => {
    expect(runner.getState('SESSION-999')).toBeNull()
  })

  it('throws PipelineSessionNotFoundError on action against unknown session', () => {
    expect(() => runner.approveStage('SESSION-999')).toThrowError(PipelineSessionNotFoundError)
  })

  it('hydrates active pipelines from DB on construction', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    const newRunner = new HarnessRunner({ sessions, conversations, tasks, approvals })
    expect(newRunner.getState(state.sessionId)).not.toBeNull()
    expect(newRunner.activeCount()).toBe(1)
  })

  it('does not hydrate terminal (done/aborted) pipelines', () => {
    const state = runner.startPipeline(createTask(), { evaluator: 'off' })
    runner.abort(state.sessionId)
    const newRunner = new HarnessRunner({ sessions, conversations, tasks, approvals })
    expect(newRunner.activeCount()).toBe(0)
  })
})

function setReady(sessionId: string): void {
  runner.markStageReady(sessionId)
}
