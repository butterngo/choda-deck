import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { renderQueueReport } from '../queue-report'

const FIXTURE_DIR = path.join(__dirname, 'fixtures/queue-1778471338165-1qtq')

describe('renderQueueReport — TASK-703 fixture', () => {
  it('contains task id, key filenames, and AC pass result', async () => {
    const output = await renderQueueReport(FIXTURE_DIR)
    expect(output).toContain('TASK-703')
    expect(output).toContain('coder.test.ts')
    expect(output).toContain('pnpm test')
    expect(output).toContain('49 passed')
  })

  it('contains run header fields', async () => {
    const output = await renderQueueReport(FIXTURE_DIR)
    expect(output).toContain('1778471338165-1qtq')
    expect(output).toContain('claude-sonnet-4-6')
    expect(output).toContain('2026-05-11')
  })

  it('contains files-changed table with coder.ts', async () => {
    const output = await renderQueueReport(FIXTURE_DIR)
    expect(output).toContain('### Files changed')
    expect(output).toContain('coder.ts')
    expect(output).toContain('modified')
  })

  it('contains artifacts tree footer', async () => {
    const output = await renderQueueReport(FIXTURE_DIR)
    expect(output).toContain('## Artifacts')
    expect(output).toContain('queue-run.json')
    expect(output).toContain('TASK-703')
  })

  it('is idempotent — two calls return byte-identical output', async () => {
    const first = await renderQueueReport(FIXTURE_DIR)
    const second = await renderQueueReport(FIXTURE_DIR)
    expect(first).toBe(second)
  })
})

describe('renderQueueReport — edge cases', () => {
  it('throws if queue-run.json is missing', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-missing-'))
    try {
      await expect(renderQueueReport(emptyDir)).rejects.toThrow('queue-run.json not found')
    } finally {
      fs.rmSync(emptyDir, { recursive: true })
    }
  })

  it('renders header-only report when tasks array is empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-empty-'))
    try {
      fs.writeFileSync(
        path.join(dir, 'queue-run.json'),
        JSON.stringify({
          queueRunId: 'test-empty',
          workspaceId: 'ws',
          branch: 'main',
          model: 'claude-sonnet-4-6',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:01:00.000Z',
          totalCostUsd: 0,
          halted: false,
          haltReason: null,
          tasks: []
        }),
        'utf8'
      )
      const output = await renderQueueReport(dir)
      expect(output).toContain('test-empty')
      expect(output).toContain('## Artifacts')
      expect(output).not.toContain('## TASK-')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })

  it('renders task section without crash when claude.json is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-no-claude-'))
    try {
      const taskDir = path.join(dir, 'tasks', 'TASK-999')
      fs.mkdirSync(taskDir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'queue-run.json'),
        JSON.stringify({
          queueRunId: 'test-no-claude',
          workspaceId: 'ws',
          branch: 'main',
          model: 'claude-sonnet-4-6',
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:01:00.000Z',
          totalCostUsd: 0,
          halted: true,
          haltReason: 'spawn-error',
          tasks: [{ id: 'TASK-999', outcome: 'FAILED' }]
        }),
        'utf8'
      )
      const output = await renderQueueReport(dir)
      expect(output).toContain('TASK-999')
      expect(output).toContain('FAILED')
      expect(output).toContain('spawn crashed')
    } finally {
      fs.rmSync(dir, { recursive: true })
    }
  })
})
