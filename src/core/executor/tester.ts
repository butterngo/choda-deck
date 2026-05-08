import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Task } from '../domain/task-types'
import { runProcess } from './coder'
import {
  type AcEntry,
  type AcReport,
  type AcStatus,
  extractAcIds,
  reportHasFailure,
  writeAcReport
} from './ac-report'
import { scanSpecFile } from './static-scan'

export interface TesterRunInput {
  task: Task
  worktreeCwd: string
  workspaceLabel: string
  branch: string
  specRelPath: string
  artifactRoot: string
  pnpmBin?: string
  timeoutMs?: number
}

export interface TesterRunOutput {
  report: AcReport
  reportPath: string
  artifactDir: string
}

export async function runTester(input: TesterRunInput): Promise<TesterRunOutput> {
  const startedAt = new Date().toISOString()
  const artifactDir = resolveArtifactDir(input)
  fs.mkdirSync(artifactDir, { recursive: true })

  const acIds = extractAcIds(input.task.body ?? '')
  const diffBefore = await captureDiff(input.worktreeCwd)

  const specAbs = path.join(input.worktreeCwd, input.specRelPath)
  const scan = scanSpecFile(specAbs)

  let entries: AcEntry[] = []
  let testRun: PlaywrightRunSummary | null = null

  if (scan.ok) {
    testRun = await runPlaywright({
      cwd: input.worktreeCwd,
      specRelPath: input.specRelPath,
      artifactDir,
      pnpmBin: input.pnpmBin ?? 'pnpm',
      timeoutMs: input.timeoutMs ?? 5 * 60 * 1000
    })
    entries = mapAcEntries(acIds, testRun, artifactDir)
  } else {
    entries = acIds.map((acId) => ({
      acId,
      status: 'fail' as AcStatus,
      evidence: [],
      notes: 'static-scan blocked test run'
    }))
  }

  const diffAfter = await captureDiff(input.worktreeCwd)
  const diffClean = diffBefore === diffAfter

  const report: AcReport = {
    taskId: input.task.id,
    workspaceId: input.workspaceLabel,
    branch: input.branch,
    startedAt,
    endedAt: new Date().toISOString(),
    entries,
    diffGuard: { before: diffBefore, after: diffAfter, clean: diffClean },
    staticScan: {
      ok: scan.ok,
      violations: scan.violations.map((v) => `L${v.line} [${v.rule}] ${v.excerpt}`)
    },
    exitCode: 0
  }
  report.exitCode = reportHasFailure(report) ? 1 : 0

  const reportPath = writeAcReport(report, artifactDir)
  return { report, reportPath, artifactDir }
}

function resolveArtifactDir(input: TesterRunInput): string {
  const project = input.task.projectId
  const taskId = input.task.id
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(input.artifactRoot, project, taskId, ts)
}

async function captureDiff(cwd: string): Promise<string> {
  const r = await runProcess('git', ['diff', 'HEAD', '--'], { cwd, timeoutMs: 30_000 })
  return r.stdout
}

interface PlaywrightRunSummary {
  rawJson: unknown
  cases: PlaywrightCase[]
}

interface PlaywrightCase {
  title: string
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted'
  attachments: Array<{ name: string; path: string | null; contentType: string | null }>
}

async function runPlaywright(args: {
  cwd: string
  specRelPath: string
  artifactDir: string
  pnpmBin: string
  timeoutMs: number
}): Promise<PlaywrightRunSummary> {
  const outputDir = path.join(args.artifactDir, 'test-results')
  const r = await runProcess(
    args.pnpmBin,
    [
      'playwright',
      'test',
      args.specRelPath,
      '--reporter=json',
      `--output=${outputDir}`
    ],
    { cwd: args.cwd, timeoutMs: args.timeoutMs }
  )

  fs.writeFileSync(path.join(args.artifactDir, 'playwright-stdout.json'), r.stdout, 'utf8')
  if (r.stderr) {
    fs.writeFileSync(path.join(args.artifactDir, 'playwright-stderr.log'), r.stderr, 'utf8')
  }

  let parsed: unknown = null
  try {
    parsed = JSON.parse(r.stdout)
  } catch {
    return { rawJson: { parseError: true, stdout: r.stdout.slice(0, 4000) }, cases: [] }
  }

  return { rawJson: parsed, cases: collectCases(parsed) }
}

function collectCases(json: unknown): PlaywrightCase[] {
  const out: PlaywrightCase[] = []
  if (!isRecord(json)) return out
  const suites = Array.isArray(json.suites) ? json.suites : []
  for (const s of suites) walkSuite(s, out)
  return out
}

function walkSuite(node: unknown, out: PlaywrightCase[]): void {
  if (!isRecord(node)) return
  const specs = Array.isArray(node.specs) ? node.specs : []
  for (const spec of specs) {
    if (!isRecord(spec)) continue
    const title = typeof spec.title === 'string' ? spec.title : ''
    const tests = Array.isArray(spec.tests) ? spec.tests : []
    for (const test of tests) {
      if (!isRecord(test)) continue
      const results = Array.isArray(test.results) ? test.results : []
      const last = results[results.length - 1]
      if (!isRecord(last)) continue
      const status = typeof last.status === 'string' ? last.status : 'failed'
      const attachments = Array.isArray(last.attachments) ? last.attachments : []
      out.push({
        title,
        status: status as PlaywrightCase['status'],
        attachments: attachments.filter(isRecord).map((a) => ({
          name: typeof a.name === 'string' ? a.name : '',
          path: typeof a.path === 'string' ? a.path : null,
          contentType: typeof a.contentType === 'string' ? a.contentType : null
        }))
      })
    }
  }
  const childSuites = Array.isArray(node.suites) ? node.suites : []
  for (const c of childSuites) walkSuite(c, out)
}

function mapAcEntries(
  acIds: string[],
  run: PlaywrightRunSummary,
  artifactDir: string
): AcEntry[] {
  const byAc = new Map<string, PlaywrightCase[]>()
  const orphans: PlaywrightCase[] = []
  for (const c of run.cases) {
    const m = /\bAC-(\d+)\b/i.exec(c.title)
    if (m) {
      const id = `AC-${m[1]}`
      const arr = byAc.get(id) ?? []
      arr.push(c)
      byAc.set(id, arr)
    } else {
      orphans.push(c)
    }
  }

  const entries: AcEntry[] = acIds.map((acId) => {
    const cases = byAc.get(acId) ?? []
    if (cases.length === 0) {
      return {
        acId,
        status: 'skip',
        evidence: [],
        notes: 'no Playwright test titled with this AC id'
      }
    }
    const allPassed = cases.every((c) => c.status === 'passed')
    const status: AcStatus = allPassed ? 'pass' : 'fail'
    const evidence = cases.flatMap((c) =>
      c.attachments
        .filter((a) => a.path)
        .map((a) => `${a.name}:${path.relative(artifactDir, a.path as string).replace(/\\/g, '/')}`)
    )
    const failedNotes = cases
      .filter((c) => c.status !== 'passed')
      .map((c) => `${c.title}: ${c.status}`)
    return {
      acId,
      status,
      evidence,
      notes: failedNotes.length > 0 ? failedNotes.join('; ') : undefined
    }
  })

  if (orphans.length > 0) {
    entries.push({
      acId: 'orphan-tests',
      status: orphans.every((c) => c.status === 'passed') ? 'pass' : 'fail',
      evidence: [],
      notes: `${orphans.length} test(s) without AC-N tag in title: ${orphans
        .map((c) => c.title)
        .join('; ')}`
    })
  }

  return entries
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
