import * as fs from 'fs'
import * as path from 'path'

export type AcStatus = 'pass' | 'fail' | 'skip'

export interface AcEntry {
  acId: string
  status: AcStatus
  evidence: string[]
  notes?: string
}

export interface AcReport {
  taskId: string
  workspaceId: string
  branch: string
  startedAt: string
  endedAt: string
  entries: AcEntry[]
  diffGuard: {
    before: string
    after: string
    clean: boolean
  }
  staticScan: {
    ok: boolean
    violations: string[]
  }
  exitCode: number
}

export function extractAcIds(taskBody: string): string[] {
  const seen = new Set<string>()
  const re = /\bAC-(\d+)\b/gi
  for (const m of taskBody.matchAll(re)) seen.add(`AC-${m[1]}`)
  return [...seen].sort((a, b) => parseAcNum(a) - parseAcNum(b))
}

function parseAcNum(id: string): number {
  return parseInt(id.split('-')[1], 10)
}

export function writeAcReport(report: AcReport, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true })
  const filePath = path.join(outDir, 'ac-report.json')
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf8')
  return filePath
}

export function reportHasFailure(report: AcReport): boolean {
  if (!report.diffGuard.clean) return true
  if (!report.staticScan.ok) return true
  return report.entries.some((e) => e.status === 'fail')
}
