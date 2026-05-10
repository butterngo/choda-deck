import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { SqliteTaskService } from '../../../core/domain/sqlite-task-service'
import type {
  ExecShellResult,
  QueueRuntime,
  SpawnClaudeInput,
  SpawnClaudeOutput
} from '../../../core/domain/lifecycle/queue-lifecycle-service'
import {
  executeWithServices,
  runRunQueueCommand,
  runQueueCommandHelp
} from './run-queue'

const TEST_DB = path.join(__dirname, '__test-run-queue-cli__.db')
let svc: SqliteTaskService

const VALID_BODY = `## Goal
Do work.

## Acceptance
- [ ] Smoke: \`pnpm run lint\`

## File Pointers
- src/foo.ts

## Scope
~1h
`

function buildRuntime(
  overrides: {
    spawn?: (input: SpawnClaudeInput) => Promise<SpawnClaudeOutput>
    exec?: (cmd: string) => Promise<ExecShellResult>
    porcelain?: string
  } = {}
): QueueRuntime {
  return {
    spawnClaude: async (input) => {
      if (overrides.spawn) return overrides.spawn(input)
      return {
        isError: false,
        totalCostUsd: 0.05,
        numTurns: 1,
        resultText: 'ok',
        rawJson: '{}'
      }
    },
    execShell: async (cmd) => {
      if (overrides.exec) return overrides.exec(cmd)
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    gitStatusPorcelain: async () => overrides.porcelain ?? '',
    gitDiff: async () => 'diff\n',
    gitCurrentBranch: async () => 'main',
    mkdir: async () => {},
    writeFile: async () => {},
    artifactsDir: '/artifacts',
    queueMcpEmptyPath: '/templates/queue-mcp-empty.json'
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('proj-q', 'Queue Project', '/tmp/q')
  svc.addWorkspace('proj-q', 'ws-q', 'Q', '/tmp/q')
})

afterEach(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

function makeServices(): {
  svc: SqliteTaskService
  dbPath: string
  dataDir: string
  artifactsDir: string
} {
  return {
    svc,
    dbPath: TEST_DB,
    dataDir: path.dirname(TEST_DB),
    artifactsDir: path.join(path.dirname(TEST_DB), 'artifacts')
  }
}

describe('run-queue CLI — args + help', () => {
  it('--help prints help and exits 0', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      const code = await runRunQueueCommand(['--help'])
      expect(code).toBe(0)
      expect(writeSpy).toHaveBeenCalledWith(runQueueCommandHelp)
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('missing --workspace returns exit 2', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await runRunQueueCommand([])
      expect(code).toBe(2)
      expect(errSpy.mock.calls[0][0]).toContain('--workspace is required')
    } finally {
      errSpy.mockRestore()
    }
  })

  it('non-numeric --max-cost-per-task returns exit 2', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const code = await runRunQueueCommand(['--workspace', 'ws-q', '--max-cost-per-task', 'abc'])
      expect(code).toBe(2)
      expect(errSpy.mock.calls[0][0]).toContain('--max-cost-per-task must be a number')
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('run-queue CLI — workspace + dry-run', () => {
  it('unknown workspace returns exit 3', async () => {
    const result = await executeWithServices(
      {
        workspaceId: 'ws-missing',
        maxCostPerTask: undefined,
        maxTasks: undefined,
        dryRun: false,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime()
    )
    expect(result.exitCode).toBe(3)
    expect(result.notes[0]).toContain('not registered')
  })

  it('dry-run with no eligible tasks returns exit 0 and zero counts', async () => {
    const result = await executeWithServices(
      {
        workspaceId: 'ws-q',
        maxCostPerTask: undefined,
        maxTasks: undefined,
        dryRun: true,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime()
    )
    expect(result.exitCode).toBe(0)
    expect(result.done).toEqual([])
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.notes.some((n) => n.includes('dry-run'))).toBe(true)
  })

  it('dirty pre-flight returns exit 4', async () => {
    const result = await executeWithServices(
      {
        workspaceId: 'ws-q',
        maxCostPerTask: undefined,
        maxTasks: undefined,
        dryRun: false,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime({ porcelain: ' M src/foo.ts\n' })
    )
    expect(result.exitCode).toBe(4)
    expect(result.halted).toBe(true)
    expect(result.haltReason).toContain('dirty')
  })
})

describe('run-queue CLI — happy path + halt', () => {
  it('all-DONE returns exit 0 with done ids populated', async () => {
    const t = svc.createTask({
      projectId: 'proj-q',
      title: 'A',
      labels: ['auto-safe'],
      body: VALID_BODY
    })
    svc.updateTask(t.id, { status: 'READY' })

    const result = await executeWithServices(
      {
        workspaceId: 'ws-q',
        maxCostPerTask: undefined,
        maxTasks: undefined,
        dryRun: false,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime()
    )
    expect(result.exitCode).toBe(0)
    expect(result.done).toContain(t.id)
    expect(result.failed).toEqual([])
    expect(result.halted).toBe(false)
  })

  it('AC-fail halts and returns exit 1', async () => {
    const t = svc.createTask({
      projectId: 'proj-q',
      title: 'B',
      labels: ['auto-safe'],
      body: VALID_BODY
    })
    svc.updateTask(t.id, { status: 'READY' })

    const result = await executeWithServices(
      {
        workspaceId: 'ws-q',
        maxCostPerTask: undefined,
        maxTasks: undefined,
        dryRun: false,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime({
        exec: async () => ({ exitCode: 1, stdout: '', stderr: 'lint failed' })
      })
    )
    expect(result.exitCode).toBe(1)
    expect(result.failed.length).toBe(1)
    expect(result.failed[0].taskId).toBe(t.id)
    expect(result.halted).toBe(true)
    expect(result.haltReason).toContain('ac-failed')
  })

  it('cost-cap-exceeded halts and returns exit 5', async () => {
    const t = svc.createTask({
      projectId: 'proj-q',
      title: 'C',
      labels: ['auto-safe'],
      body: VALID_BODY
    })
    svc.updateTask(t.id, { status: 'READY' })

    const result = await executeWithServices(
      {
        workspaceId: 'ws-q',
        maxCostPerTask: 0.1,
        maxTasks: undefined,
        dryRun: false,
        claudeBin: undefined,
        model: undefined
      },
      makeServices(),
      buildRuntime({
        spawn: async () => ({
          isError: false,
          totalCostUsd: 0.5,
          numTurns: 1,
          resultText: 'ok',
          rawJson: '{}'
        })
      })
    )
    expect(result.exitCode).toBe(5)
    expect(result.halted).toBe(true)
    expect(result.haltReason).toMatch(/cost-cap-exceeded/)
  })
})
