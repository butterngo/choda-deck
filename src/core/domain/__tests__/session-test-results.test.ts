import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import { loadLastSession } from '../../../adapters/mcp/mcp-tools/session-tools'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-session-tr__.db')
let svc: SqliteTaskService

beforeAll(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  await svc.ensureProject('tr', 'TestResults', '/tmp/tr')
})

afterAll(async () => {
  await svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('loadLastSession — testResults surface', () => {
  it('carries testResults when handoff has it', async () => {
    const s = await svc.createSession({ projectId: 'tr', workspaceId: 'qa-ws' })
    await svc.updateSession(s.id, {
      status: 'completed',
      endedAt: '2026-04-23',
      handoff: {
        resumePoint: 'qa done',
        testResults: {
          passed: ['login E2E via Playwright'],
          skipped: ['IE11 manual — no VM available']
        }
      }
    })

    const last = await loadLastSession(svc, 'tr', 'qa-ws')
    expect(last).not.toBeNull()
    expect(last!.testResults).toEqual({
      passed: ['login E2E via Playwright'],
      skipped: ['IE11 manual — no VM available']
    })
  })

  it('returns testResults=null when handoff lacks it', async () => {
    const s = await svc.createSession({ projectId: 'tr', workspaceId: 'notest-ws' })
    await svc.updateSession(s.id, {
      status: 'completed',
      endedAt: '2026-04-23',
      handoff: { resumePoint: 'no tests' }
    })

    const last = await loadLastSession(svc, 'tr', 'notest-ws')
    expect(last!.testResults).toBeNull()
  })
})
