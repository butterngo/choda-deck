import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import { readWeekPick, weekPickFile, writeWeekPick } from './activity-week'
import { isGreen, rulesCheck, swapWeekSlot, type GhRunner, type OpenPr } from './rules-check'

// TASK-3129 — rules 1 and 2 of personal-operating-rules, with an injected gh runner.

const WEEK = '2026-W45'
let dir: string
let db: Database.Database

const ok = { conclusion: 'SUCCESS' }
const greenPr: OpenPr = { url: 'https://github.com/x/r/pull/7', statusCheckRollup: [ok, ok] }
const failingPr: OpenPr = {
  url: 'https://github.com/x/r/pull/8',
  statusCheckRollup: [ok, { conclusion: 'FAILURE' }]
}
const pendingPr: OpenPr = {
  url: 'https://github.com/x/r/pull/9',
  statusCheckRollup: [{ conclusion: null, state: 'PENDING' }]
}
const noPrs: GhRunner = () => []
const prs =
  (list: OpenPr[]): GhRunner =>
  () =>
    list

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-check-'))
  db = new Database(':memory:')
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, cwd TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, label TEXT, cwd TEXT, archived_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT, updated_at TEXT);`)
  for (const id of ['tms', 'mavue-studio', 'ba-nghiep', 'juvenis-maxime', 'capabilities']) {
    db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, id, `C:\\dev\\${id}`)
  }
  writeWeekPick(dir, {
    week: WEEK,
    picked: ['tms', 'mavue-studio', 'ba-nghiep', 'juvenis-maxime'],
    pickedAt: '2026-11-02T00:00:00Z',
    swaps: []
  })
})
afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function task(id: string, projectId: string, status: string, updatedAt = '2026-11-06'): void {
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?, ?)').run(id, projectId, status, updatedAt)
}

describe('rulesCheck — rule 1', () => {
  it('passes a picked project with nothing waiting', () => {
    expect(rulesCheck(db, dir, 'tms', WEEK, noPrs)).toEqual({
      projectId: 'tms',
      week: WEEK,
      verdict: 'pass',
      reasons: [],
      warnings: []
    })
  })

  it('without a pick file, blocks with one rule-1 reason pointing at activity week pick', () => {
    fs.rmSync(weekPickFile(dir, WEEK))
    const r = rulesCheck(db, dir, 'tms', WEEK, noPrs)
    expect(r.verdict).toBe('blocked')
    expect(r.reasons).toHaveLength(1)
    expect(r.reasons[0].rule).toBe(1)
    expect(r.reasons[0].message).toContain('activity week pick')
  })

  it('a project outside the pick is blocked with a rule-1 reason listing the 4 picked ids', () => {
    const r = rulesCheck(db, dir, 'capabilities', WEEK, noPrs)
    expect(r.verdict).toBe('blocked')
    expect(r.reasons[0].rule).toBe(1)
    for (const id of ['tms', 'mavue-studio', 'ba-nghiep', 'juvenis-maxime']) {
      expect(r.reasons[0].message).toContain(id)
    }
  })
})

describe('rulesCheck — rule 2', () => {
  it('a green open PR blocks with a rule-2 reason whose url is that PR', () => {
    const r = rulesCheck(db, dir, 'tms', WEEK, prs([greenPr]))
    expect(r.verdict).toBe('blocked')
    expect(r.reasons).toEqual([
      { rule: 2, message: expect.stringContaining(greenPr.url), url: greenPr.url }
    ])
  })

  it('an open PR with a failing or a pending check gives no rule-2 reason', () => {
    expect(isGreen(failingPr)).toBe(false)
    expect(isGreen(pendingPr)).toBe(false)
    expect(isGreen({ url: 'u', statusCheckRollup: [] })).toBe(false)
    const r = rulesCheck(db, dir, 'tms', WEEK, prs([failingPr, pendingPr]))
    expect(r.verdict).toBe('pass')
    expect(r.reasons).toEqual([])
  })

  it('a gh failure is a warning and never blocks on its own', () => {
    const broken: GhRunner = () => {
      throw new Error('spawn gh ENOENT')
    }
    const r = rulesCheck(db, dir, 'tms', WEEK, broken)
    expect(r.verdict).toBe('pass')
    expect(r.warnings[0]).toContain('cannot check PRs: spawn gh ENOENT')
  })

  it('one IMPLEMENTED task, however old, blocks naming it; none passes', () => {
    task('TASK-1', 'tms', 'IMPLEMENTED', '2025-01-01')
    const r = rulesCheck(db, dir, 'tms', WEEK, noPrs)
    expect(r.verdict).toBe('blocked')
    expect(r.reasons).toHaveLength(1)
    expect(r.reasons[0]).toMatchObject({ rule: 2 })
    expect(r.reasons[0].message).toContain('TASK-1')

    db.prepare("UPDATE tasks SET status = 'DONE' WHERE id = 'TASK-1'").run()
    expect(rulesCheck(db, dir, 'tms', WEEK, noPrs).verdict).toBe('pass')
  })
})

describe('swapWeekSlot', () => {
  it('a clean picked project hands its slot over and the swap is recorded', () => {
    const res = swapWeekSlot(db, dir, WEEK, 'tms', 'capabilities', {
      gh: noPrs,
      now: new Date('2026-11-06T10:00:00Z')
    })
    expect(res.ok).toBe(true)
    const pick = readWeekPick(dir, WEEK)!
    expect(pick.picked).toEqual(['capabilities', 'mavue-studio', 'ba-nghiep', 'juvenis-maxime'])
    expect(pick.swaps).toEqual([{ out: 'tms', in: 'capabilities', at: '2026-11-06T10:00:00.000Z' }])
  })

  it('a READY task in <out> refuses with code 3 naming it and leaves the file byte-identical', () => {
    task('TASK-9', 'tms', 'READY')
    const before = fs.readFileSync(weekPickFile(dir, WEEK))
    const res = swapWeekSlot(db, dir, WEEK, 'tms', 'capabilities', { gh: noPrs })
    expect(res).toMatchObject({ ok: false, code: 3 })
    expect(!res.ok && res.error).toContain('TASK-9')
    expect(fs.readFileSync(weekPickFile(dir, WEEK)).equals(before)).toBe(true)
  })

  it('a green open PR in <out> refuses with code 3 naming the PR and leaves the file unchanged', () => {
    const before = fs.readFileSync(weekPickFile(dir, WEEK))
    const res = swapWeekSlot(db, dir, WEEK, 'tms', 'capabilities', { gh: prs([greenPr]) })
    expect(res).toMatchObject({ ok: false, code: 3 })
    expect(!res.ok && res.error).toContain(greenPr.url)
    expect(fs.readFileSync(weekPickFile(dir, WEEK)).equals(before)).toBe(true)
  })

  it('--override swaps an unclean project and records the reason', () => {
    task('TASK-9', 'tms', 'IN-PROGRESS')
    const res = swapWeekSlot(db, dir, WEEK, 'tms', 'capabilities', {
      override: 'client paused the project',
      gh: noPrs
    })
    expect(res.ok).toBe(true)
    expect(readWeekPick(dir, WEEK)!.swaps[0]).toMatchObject({
      out: 'tms',
      in: 'capabilities',
      override: 'client paused the project'
    })
  })

  it('refuses with code 1 when <out> is not picked or <in> already is, naming the id', () => {
    const notPicked = swapWeekSlot(db, dir, WEEK, 'capabilities', 'tms', { gh: noPrs })
    expect(notPicked).toMatchObject({ ok: false, code: 1 })
    expect(!notPicked.ok && notPicked.error).toContain('"capabilities"')
    const already = swapWeekSlot(db, dir, WEEK, 'tms', 'mavue-studio', { gh: noPrs })
    expect(already).toMatchObject({ ok: false, code: 1 })
    expect(!already.ok && already.error).toContain('"mavue-studio"')
  })

  it('after a swap, rules check passes rule 1 for <in> and blocks it for <out>', () => {
    swapWeekSlot(db, dir, WEEK, 'tms', 'capabilities', { gh: noPrs })
    expect(rulesCheck(db, dir, 'capabilities', WEEK, noPrs).reasons).toEqual([])
    expect(rulesCheck(db, dir, 'tms', WEEK, noPrs).reasons.map((r) => r.rule)).toEqual([1])
  })
})
