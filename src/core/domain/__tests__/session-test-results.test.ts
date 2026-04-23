import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { SqliteTaskService } from '../sqlite-task-service'
import { loadLastSession } from '../../../adapters/mcp/mcp-tools/session-tools'
import * as fs from 'fs'
import * as path from 'path'

const TEST_DB = path.join(__dirname, '__test-session-tr__.db')
let svc: SqliteTaskService

beforeAll(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
  svc = new SqliteTaskService(TEST_DB)
  svc.ensureProject('tr', 'TestResults', '/tmp/tr')
})

afterAll(() => {
  svc.close()
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB)
})

describe('loadLastSession — testResults surface', () => {
  it('carries testResults when handoff has it', () => {
    const s = svc.createSession({ projectId: 'tr', workspaceId: 'qa-ws' })
    svc.updateSession(s.id, {
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

    const last = loadLastSession(svc, 'tr', 'qa-ws')
    expect(last).not.toBeNull()
    expect(last!.testResults).toEqual({
      passed: ['login E2E via Playwright'],
      skipped: ['IE11 manual — no VM available']
    })
  })

  it('returns testResults=null when handoff lacks it', () => {
    const s = svc.createSession({ projectId: 'tr', workspaceId: 'notest-ws' })
    svc.updateSession(s.id, {
      status: 'completed',
      endedAt: '2026-04-23',
      handoff: { resumePoint: 'no tests' }
    })

    const last = loadLastSession(svc, 'tr', 'notest-ws')
    expect(last!.testResults).toBeNull()
  })
})
