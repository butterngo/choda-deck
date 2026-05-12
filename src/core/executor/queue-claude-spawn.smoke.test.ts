import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SpawnClaudeInput } from '../domain/lifecycle/queue-lifecycle-service'
import { createQueueClaudeSpawner } from './queue-claude-spawn'

// Opt-in e2e smoke — exercises createQueueClaudeSpawner against a real `claude`
// binary. Regression guard for the two bugs that TASK-700's manual live run
// caught (missing prompt arg + cmd.exe mangling multi-line stdin). Skipped by
// default so the hermetic suite stays green without claude installed.
//
// Run with: CHODA_E2E_CLAUDE=1 pnpm test src/core/executor/queue-claude-spawn.smoke.test.ts
const E2E_ENABLED = process.env.CHODA_E2E_CLAUDE === '1'

describe.skipIf(!E2E_ENABLED)('createQueueClaudeSpawner — e2e smoke', () => {
  let tmpDir: string
  let mcpEmptyPath: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-queue-smoke-'))
    mcpEmptyPath = path.join(tmpDir, 'queue-mcp-empty.json')
    fs.writeFileSync(mcpEmptyPath, '{"mcpServers":{}}\n', 'utf8')
  })

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('spawns real claude with multi-line stdin and returns parseable JSON', async () => {
    const input: SpawnClaudeInput = {
      taskBody: [
        '## Goal',
        '',
        'Return JSON {"ok":true}',
        '',
        '## Acceptance',
        '- nothing'
      ].join('\n'),
      cwd: tmpDir,
      model: 'claude-haiku-4-5-20251001',
      maxBudgetUsd: 0.05,
      queueMcpEmptyPath: mcpEmptyPath,
      claudeBin: 'claude',
      prewarm: false
    }

    const spawner = createQueueClaudeSpawner({ spawnTimeoutMs: 120_000 })
    const out = await spawner(input)

    expect(out.isError).toBe(false)
    expect(typeof out.totalCostUsd).toBe('number')
    expect(() => JSON.parse(out.rawJson)).not.toThrow()
  }, 180_000)
})
