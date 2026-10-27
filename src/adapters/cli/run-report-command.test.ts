import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { acCoverage, acRows, readAcTicks, type AcCoverage } from '../../core/domain/lifecycle/ac-coverage'
import { parseReportFrontmatter } from '../../core/domain/services/run-report'
import { gitShow, runReportCommand, type RunReportCommandDeps } from './run-report-command'

// TASK-2600 — `choda-deck run report` against a real SQLite service and a real
// git repo holding the items' commits.

let tmp: string
let home: string
let repo: string
let svc: SqliteTaskService
let out: string
let err: string

const io = {
  out: (t: string): void => {
    out += t
  },
  err: (t: string): void => {
    err += t
  }
}

function deps(): RunReportCommandDeps {
  return {
    getTask: (id) => svc.getTask(id),
    getSubtasks: (id) => svc.getSubtasks(id),
    findSessions: (p) => svc.findSessions(p),
    listSessionEvents: (id, type) => svc.listSessionEvents(id, type),
    getRelationshipsFrom: (id, type) => svc.getRelationshipsFrom(id, type),
    getRelationshipsTo: (id, type) => svc.getRelationshipsTo(id, type),
    getProject: (id) => svc.getProject(id),
    getWorkspace: (id) => svc.getWorkspace(id),
    gitShow,
    now: () => '2026-10-22T00:00:00.000Z',
    homeCwd: async () => home
  }
}

const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

/** One commit adding one `[Fact]` method and one `it("x")`; returns its sha. */
function commitTests(): string {
  fs.mkdirSync(path.join(repo, 'tests'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'tests', 'XTests.cs'),
    ['public class XTests', '{', '    [Fact]', '    public void A_thing_works()', '    {', '    }', '}', ''].join('\n')
  )
  fs.writeFileSync(path.join(repo, 'a.test.ts'), ["it(\"x\", () => {})", ''].join('\n'))
  git('add', '.')
  git('commit', '-q', '-m', 'feat: item (TASK-11)')
  return git('rev-parse', '--short', 'HEAD')
}

const BODY = ['## Acceptance', '- [ ] first — test', '- [ ] second — test', '- [ ] a person looks — human', ''].join('\n')

async function session(taskId: string, startedAt: string, handoff: Record<string, unknown>): Promise<string> {
  const s = await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId, startedAt })
  await svc.updateSession(s.id, { status: 'completed', endedAt: startedAt, handoff })
  return s.id
}

/** The frontmatter values, each line `key: <json>`. */
function frontmatter(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf8')
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const fm: Record<string, unknown> = {}
  for (const line of block.split('\n')) {
    const i = line.indexOf(': ')
    fm[line.slice(0, i)] = JSON.parse(line.slice(i + 2))
  }
  return fm
}

const reportPath = (): string => path.join(home, 'docs', 'reports', 'task-10-test-report.md')

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'run-report-'))
  home = path.join(tmp, 'home')
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(home)
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  git('commit', '-q', '--allow-empty', '-m', 'root')
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', home)
  await svc.addWorkspace('p', 'web', 'Web', repo)
  await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY' })
  out = ''
  err = ''
})

afterEach(async () => {
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('choda-deck run report', () => {
  it('TASK-2790: run from inside a worktree of the home workspace, it writes into that worktree, not the registered cwd', async () => {
    const worktree = `${home}.worktrees${path.sep}autopilot-TASK-10`
    const runIn = { ...deps(), cwd: () => path.join(worktree, 'src', 'deep') }
    expect(await runReportCommand(['TASK-10'], io, runIn)).toBe(0)
    const written = path.join(worktree, 'docs', 'reports', 'task-10-test-report.md')
    expect(out.trim()).toBe(written)
    expect(fs.existsSync(written)).toBe(true)
    expect(fs.existsSync(reportPath())).toBe(false)
  })

  it('an unknown goal returns exit code 2', async () => {
    expect(await runReportCommand(['TASK-999'], io, deps())).toBe(2)
    expect(err).toContain('unknown goal: TASK-999')
  })

  it('the newest item session with a fixed suite line sets suite', async () => {
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
    await session('TASK-11', '2026-10-20T08:00:00.000Z', {
      testResults: { passed: ['full suite: 700 passed, 0 skipped, 0 failed'], skipped: [] }
    })
    await session('TASK-11', '2026-10-21T08:00:00.000Z', {
      testResults: { passed: ['full suite: 760 passed, 1 skipped, 0 failed'], skipped: [] }
    })
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(out.trim()).toBe(reportPath())
    expect(frontmatter(reportPath()).suite).toEqual({ passed: 760, skipped: 1, failed: 0 })
  })

  describe('suites per workspace (TASK-2637)', () => {
    async function inWorkspace(workspaceId: string, taskId: string, startedAt: string, line: string): Promise<void> {
      const s = await svc.createSession({ projectId: 'p', workspaceId, taskId, startedAt })
      await svc.updateSession(s.id, {
        status: 'completed',
        endedAt: startedAt,
        handoff: { testResults: { passed: [line], skipped: [] } }
      })
    }

    beforeEach(async () => {
      await svc.addWorkspace('p', 'b', 'B', repo)
      await svc.addWorkspace('p', 'a', 'A', repo)
      await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
      await svc.createTask({ id: 'TASK-12', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item 2', body: BODY })
      // b is the newest overall, so `suite` must come from b.
      await inWorkspace('a', 'TASK-11', '2026-10-20T08:00:00.000Z', 'full suite: 10 passed, 0 skipped, 0 failed')
      await inWorkspace('b', 'TASK-12', '2026-10-21T08:00:00.000Z', 'full suite: 20 passed, 1 skipped, 0 failed')
    })

    it('a goal with item sessions in workspaces a and b writes suites with both, ordered a then b', async () => {
      expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
      expect(frontmatter(reportPath()).suites).toEqual([
        { workspaceId: 'a', passed: 10, skipped: 0, failed: 0 },
        { workspaceId: 'b', passed: 20, skipped: 1, failed: 0 }
      ])
    })

    it('two sessions in the same workspace keep only the newer one in suites', async () => {
      await inWorkspace('a', 'TASK-12', '2026-10-19T08:00:00.000Z', 'full suite: 5 passed, 0 skipped, 0 failed')
      await inWorkspace('a', 'TASK-11', '2026-10-20T09:00:00.000Z', 'full suite: 11 passed, 0 skipped, 0 failed')
      expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
      const suites = frontmatter(reportPath()).suites as { workspaceId: string; passed: number }[]
      expect(suites.filter((s) => s.workspaceId === 'a')).toEqual([{ workspaceId: 'a', passed: 11, skipped: 0, failed: 0 }])
    })

    it('the same fixture still writes suite from the newest session overall', async () => {
      expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
      expect(frontmatter(reportPath()).suite).toEqual({ passed: 20, skipped: 1, failed: 0 })
    })

    it('the written report read back with parseReportFrontmatter returns suites with both entries', async () => {
      expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
      const fm = parseReportFrontmatter(fs.readFileSync(reportPath(), 'utf8'))
      expect(fm?.suites?.map((s) => s.workspaceId)).toEqual(['a', 'b'])
    })

    it('a report text with every other key but no suites line still parses', async () => {
      expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
      const old = fs
        .readFileSync(reportPath(), 'utf8')
        .split(/\r?\n/)
        .filter((l) => !l.startsWith('suites: '))
        .join('\n')
      expect(old).not.toContain('suites: ')
      const fm = parseReportFrontmatter(old)
      expect(fm).not.toBeNull()
      expect(fm?.suites).toBeUndefined()
      expect(fm?.suite).toEqual({ passed: 20, skipped: 1, failed: 0 })
    })
  })

  it('items with only free-text suite lines give suite null', async () => {
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
    await session('TASK-11', '2026-10-21T08:00:00.000Z', { testResults: { passed: ['vitest 860/860'], skipped: [] } })
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(frontmatter(reportPath()).suite).toBeNull()
  })

  it('a commit adding one [Fact] and one it("x") counts testsAdded 2', async () => {
    const sha = commitTests()
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
    await session('TASK-11', '2026-10-21T08:00:00.000Z', { commits: [`${sha} feat: item (TASK-11)`] })
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    const fm = frontmatter(reportPath())
    expect(fm.testsAdded).toBe(2)
    expect(fm.unreadableCommits).toEqual([])
  })

  it('a commit sha missing from the repo is listed in unreadableCommits', async () => {
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
    await session('TASK-11', '2026-10-21T08:00:00.000Z', { commits: ['deadbee gone (TASK-11)'] })
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(frontmatter(reportPath()).unreadableCommits).toEqual(['deadbee'])
  })

  it('ac equals the sum of the items coverage from the TASK-2597 function', async () => {
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'One', body: BODY })
    await svc.createTask({ id: 'TASK-12', projectId: 'p', parentTaskId: 'TASK-10', title: 'Two', body: BODY })
    const s = await svc.createSession({ projectId: 'p', workspaceId: 'web', taskId: 'TASK-11', startedAt: '2026-10-21T08:00:00.000Z' })
    await svc.checkAcItem({ taskId: 'TASK-11', acIndex: 0, evidence: 'e', workspaceId: 'web', method: 'test', ref: 'T.a' })
    await svc.updateSession(s.id, { status: 'completed', endedAt: '2026-10-21T08:10:00.000Z' })

    const expected: AcCoverage = { covered: 0, weak: 0, open: 0, human: 0, total: 0 }
    const sessions = await svc.findSessions('p')
    for (const id of ['TASK-11', 'TASK-12']) {
      const task = await svc.getTask(id)
      const ids = sessions.filter((x) => x.taskId === id).map((x) => x.id)
      const cov = acCoverage(acRows(task?.body ?? null, await readAcTicks((a, b) => svc.listSessionEvents(a, b), id, ids)))
      for (const k of Object.keys(expected) as (keyof AcCoverage)[]) expected[k] += cov[k]
    }

    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(frontmatter(reportPath()).ac).toEqual(expected)
    expect(expected).toEqual({ covered: 1, weak: 0, open: 3, human: 2, total: 6 })
  })

  it('--smoke with a valid file copies its checks into the frontmatter', async () => {
    const checks = [
      { name: 'list apps', call: 'GET /apps', expect: '200', got: '200', ok: true },
      { name: 'create record', call: 'POST /records', expect: '201', got: '500', ok: false }
    ]
    const smokeFile = path.join(tmp, 'smoke.json')
    fs.writeFileSync(
      smokeFile,
      JSON.stringify({ env: 'qc', base: 'https://test-api.ichiba.net/bpa/x', build: 'abc', ranAt: '2026-10-22T01:00:00Z', checks, data: ['zz_test_TASK-10_1'] })
    )
    expect(await runReportCommand(['TASK-10', '--smoke', smokeFile], io, deps())).toBe(0)
    expect((frontmatter(reportPath()).smoke as { checks: unknown }).checks).toEqual(checks)
  })

  it('--smoke with invalid JSON returns exit code 3 and writes no file', async () => {
    const smokeFile = path.join(tmp, 'smoke.json')
    fs.writeFileSync(smokeFile, '{ not json')
    expect(await runReportCommand(['TASK-10', '--smoke', smokeFile], io, deps())).toBe(3)
    expect(err).toContain('smoke file is not valid')
    expect(fs.existsSync(reportPath())).toBe(false)
  })

  it('a DONE task outside the goal that realizes its feature is listed under regression', async () => {
    const slug = (
      await svc.createKnowledge({ projectId: 'p', type: 'feature', scope: 'project', title: 'Runs', body: 'x', refs: [] })
    ).slug
    await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item', body: BODY })
    await svc.createTask({ id: 'TASK-30', projectId: 'p', title: 'Shipped earlier', status: 'DONE' })
    await svc.createTask({ id: 'TASK-31', projectId: 'p', title: 'Not finished', status: 'TODO' })
    for (const id of ['TASK-10', 'TASK-11', 'TASK-30', 'TASK-31']) await svc.addRelationship(id, slug, 'REALIZES')
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(frontmatter(reportPath()).regression).toEqual([{ task: 'TASK-30', title: 'Shipped earlier' }])
  })

  it('a goal with no feature has an empty regression list', async () => {
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(frontmatter(reportPath()).regression).toEqual([])
  })

  it('the written file reads back through parseReportFrontmatter (GET /runs)', async () => {
    expect(await runReportCommand(['TASK-10'], io, deps())).toBe(0)
    expect(parseReportFrontmatter(fs.readFileSync(reportPath(), 'utf8'))?.goal).toBe('TASK-10')
  })

  it('--out writes to the given path', async () => {
    const target = path.join(tmp, 'elsewhere', 'r.md')
    expect(await runReportCommand(['TASK-10', '--out', target], io, deps())).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toContain('# Test report — TASK-10')
  })
})
