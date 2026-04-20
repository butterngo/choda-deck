import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getSessionArtifactsDir,
  writePlanArtifact,
  writePlannerFailureArtifact,
  type PlannerFailureArtifact
} from './artifacts'
import type { StageDiagnostics } from './stage-runner'

describe('artifacts', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'choda-artifacts-'))
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('getSessionArtifactsDir returns <dataDir>/data/artifacts/<sessionId>', () => {
    expect(getSessionArtifactsDir({ dataDir }, 'S42')).toBe(
      join(dataDir, 'data', 'artifacts', 'S42')
    )
  })

  it('writePlanArtifact creates dirs and writes plan.json', () => {
    const plan = { files: [{ path: 'src/x.ts', action: 'create', why: 'needed' }] }
    const filePath = writePlanArtifact({ dataDir }, 'S42', plan)

    expect(filePath).toBe(join(dataDir, 'data', 'artifacts', 'S42', 'plan.json'))
    expect(existsSync(filePath)).toBe(true)
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(plan)
  })

  it('overwrites existing plan.json without errors', () => {
    writePlanArtifact({ dataDir }, 'S42', { version: 1 })
    writePlanArtifact({ dataDir }, 'S42', { version: 2 })

    const filePath = join(dataDir, 'data', 'artifacts', 'S42', 'plan.json')
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual({ version: 2 })
  })

  it('writePlannerFailureArtifact creates planner-failure.json with full shape', () => {
    const diagnostics: StageDiagnostics = {
      exitCode: 1,
      stdout: '{"type":"result","is_error":true}',
      stderr: '',
      parsed: { type: 'result', is_error: true },
      cmd: 'claude -p --model claude-opus-4-7',
      env: { NODE_ENV: 'test', PATH_fingerprint_sha256_8: 'abcdef12' },
      workspacePath: '/tmp/ws',
      durationMs: 1234,
      timedOut: false
    }
    const failure: PlannerFailureArtifact = {
      errorCode: 'STAGE_NON_ZERO_EXIT',
      errorMessage: 'Claude exited with code 1',
      sessionId: 'S42',
      stage: 'plan',
      iteration: 0,
      createdAt: '2026-04-20T14:00:00.000Z',
      diagnostics
    }

    const filePath = writePlannerFailureArtifact({ dataDir }, 'S42', failure)

    expect(filePath).toBe(join(dataDir, 'data', 'artifacts', 'S42', 'planner-failure.json'))
    expect(existsSync(filePath)).toBe(true)
    const read = JSON.parse(readFileSync(filePath, 'utf8')) as PlannerFailureArtifact
    expect(read).toEqual(failure)
    expect(read.diagnostics.cmd).toContain('--model')
    expect(read.diagnostics.env.NODE_ENV).toBe('test')
  })
})
