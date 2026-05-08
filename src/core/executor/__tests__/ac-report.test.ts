import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AcReport,
  extractAcIds,
  reportHasFailure,
  writeAcReport
} from '../ac-report'

describe('extractAcIds', () => {
  it('extracts AC ids from task body and sorts numerically', () => {
    const body = `## Acceptance
- [ ] **AC-2** thing
- [ ] AC-10 second
- [ ] **AC-1** first
`
    expect(extractAcIds(body)).toEqual(['AC-1', 'AC-2', 'AC-10'])
  })

  it('dedupes same id mentioned twice', () => {
    expect(extractAcIds('AC-1 ... AC-1 again')).toEqual(['AC-1'])
  })

  it('returns empty for body without ids', () => {
    expect(extractAcIds('no acceptance criteria here')).toEqual([])
  })
})

describe('writeAcReport + reportHasFailure', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-report-'))

  it('serialises report to ac-report.json', () => {
    const report: AcReport = {
      taskId: 'TASK-001',
      workspaceId: 'remote-workflow',
      branch: 'feat/x',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      entries: [{ acId: 'AC-1', status: 'pass', evidence: ['screenshot:foo.png'] }],
      diffGuard: { before: '', after: '', clean: true },
      staticScan: { ok: true, violations: [] },
      exitCode: 0
    }
    const out = path.join(tmpRoot, 'run-1')
    const reportPath = writeAcReport(report, out)
    expect(fs.existsSync(reportPath)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    expect(parsed.taskId).toBe('TASK-001')
    expect(parsed.entries[0].acId).toBe('AC-1')
  })

  it('reportHasFailure flags AC fail', () => {
    const r = baseReport({ status: 'fail' })
    expect(reportHasFailure(r)).toBe(true)
  })

  it('reportHasFailure flags dirty diff', () => {
    const r = baseReport({ diffClean: false })
    expect(reportHasFailure(r)).toBe(true)
  })

  it('reportHasFailure flags static scan violation', () => {
    const r = baseReport({ scanOk: false })
    expect(reportHasFailure(r)).toBe(true)
  })

  it('reportHasFailure returns false when all pass', () => {
    expect(reportHasFailure(baseReport({}))).toBe(false)
  })
})

function baseReport(overrides: {
  status?: 'pass' | 'fail' | 'skip'
  diffClean?: boolean
  scanOk?: boolean
}): AcReport {
  return {
    taskId: 'T1',
    workspaceId: 'ws',
    branch: 'b',
    startedAt: '',
    endedAt: '',
    entries: [{ acId: 'AC-1', status: overrides.status ?? 'pass', evidence: [] }],
    diffGuard: { before: '', after: '', clean: overrides.diffClean ?? true },
    staticScan: { ok: overrides.scanOk ?? true, violations: [] },
    exitCode: 0
  }
}
