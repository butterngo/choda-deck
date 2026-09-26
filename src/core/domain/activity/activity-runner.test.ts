import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import Database from 'better-sqlite3'
import { initSchema } from '../repositories/schema'
import {
  runActivityDigest,
  addDays,
  localMidnightUtc,
  activityDir,
  type ActivityRunnerOptions
} from './activity-runner'

// TASK-2151 — the runner against temp HOME / data dir / git repos. `now` is pinned
// so "today" is deterministic: 2026-09-26 10:00 local (UTC+7).

const NOW = new Date('2026-09-26T03:00:00Z')
const TODAY = '2026-09-26'
const DATE = '2026-09-25'

let tmp: string
let home: string
let artifactsDir: string
let db: Database.Database

function writeTranscript(lines: object[]): void {
  const dir = path.join(home, '.claude', 'projects', 'C--ws')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'))
}

function opts(extra: Partial<ActivityRunnerOptions> = {}): ActivityRunnerOptions {
  return { artifactsDir, db, homeDir: home, now: NOW, ...extra }
}

function registerWorkspace(id: string, cwd: string): void {
  db.prepare("INSERT OR IGNORE INTO projects (id, name, cwd) VALUES ('p', 'P', ?)").run(cwd)
  db.prepare("INSERT INTO workspaces (id, project_id, label, cwd) VALUES (?, 'p', ?, ?)").run(
    id,
    id,
    cwd
  )
}

function gitRepo(dir: string, commits: { at: string }[]): void {
  fs.mkdirSync(dir, { recursive: true })
  const g = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore'
    })
  g(['init', '-q', '-b', 'master'])
  commits.forEach((c, i) => {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i))
    g(['add', '.'])
    g(['commit', '-q', '-m', `c${i}`], { GIT_AUTHOR_DATE: c.at, GIT_COMMITTER_DATE: c.at })
  })
  g(['update-ref', 'refs/remotes/origin/master', 'HEAD'])
  g(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master'])
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-runner-'))
  home = path.join(tmp, 'home')
  artifactsDir = path.join(tmp, 'data', 'artifacts')
  db = new Database(':memory:')
  initSchema(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('date helpers', () => {
  it('local midnight in UTC+7 is 17:00Z the previous day', () => {
    expect(new Date(localMidnightUtc('2026-09-25', 'Asia/Ho_Chi_Minh')).toISOString()).toBe(
      '2026-09-24T17:00:00.000Z'
    )
  })
  it('addDays crosses month boundaries', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30')
  })
})

describe('runActivityDigest — TASK-2151', () => {
  it('AC-1: two runs for the same date are byte-identical apart from generatedAt', () => {
    writeTranscript([
      {
        type: 'user',
        timestamp: '2026-09-25T03:00:00Z',
        sessionId: 'S',
        cwd: 'C:/ws',
        message: { content: 'do it' }
      },
      {
        type: 'assistant',
        timestamp: '2026-09-25T03:02:00Z',
        sessionId: 'S',
        cwd: 'C:/ws',
        message: { content: [] }
      }
    ])
    const file = path.join(activityDir(artifactsDir), `${DATE}.json`)
    runActivityDigest({ date: DATE }, opts({ now: NOW }))
    const first = JSON.parse(fs.readFileSync(file, 'utf8'))
    runActivityDigest({ date: DATE }, opts({ now: new Date(NOW.getTime() + 60_000) }))
    const second = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(first.generatedAt).not.toBe(second.generatedAt)
    delete first.generatedAt
    delete second.generatedAt
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.metrics.prompts).toBe(1)
  })

  it('AC-2: counts first-parent commits on origin/HEAD (master) inside the local day only', () => {
    const repo = path.join(tmp, 'repo')
    gitRepo(repo, [
      { at: '2026-09-24T10:00:00+07:00' },
      { at: '2026-09-25T09:00:00+07:00' },
      { at: '2026-09-25T18:00:00+07:00' }
    ])
    registerWorkspace('ws', repo)
    registerWorkspace('ws-sub', path.join(repo, 'sub-folder-that-does-not-exist'))
    runActivityDigest({ date: DATE }, opts())
    const d = JSON.parse(
      fs.readFileSync(path.join(activityDir(artifactsDir), `${DATE}.json`), 'utf8')
    )
    expect(d.metrics.mergesToDefault).toBe(2)
    expect(d.sources.skippedRepos).toBe(1)
  })

  it('a repo registered twice is counted once', () => {
    const repo = path.join(tmp, 'repo')
    gitRepo(repo, [{ at: '2026-09-25T09:00:00+07:00' }])
    registerWorkspace('a', repo)
    registerWorkspace('b', repo)
    runActivityDigest({ date: DATE }, opts())
    const d = JSON.parse(
      fs.readFileSync(path.join(activityDir(artifactsDir), `${DATE}.json`), 'utf8')
    )
    expect(d.metrics.mergesToDefault).toBe(1)
  })

  it('AC-3: prunes files older than 90 days and keeps newer ones', () => {
    const dir = activityDir(artifactsDir)
    fs.mkdirSync(dir, { recursive: true })
    const old = `${addDays(TODAY, -91)}.json`
    const recent = `${addDays(TODAY, -89)}.json`
    fs.writeFileSync(path.join(dir, old), '{}')
    fs.writeFileSync(path.join(dir, recent), '{}')
    runActivityDigest({ date: DATE }, opts())
    expect(fs.existsSync(path.join(dir, old))).toBe(false)
    expect(fs.existsSync(path.join(dir, recent))).toBe(true)
  })

  it('AC-4: catch-up creates the missing date and leaves existing files untouched', () => {
    const dir = activityDir(artifactsDir)
    fs.mkdirSync(dir, { recursive: true })
    const past = new Date('2026-01-01T00:00:00Z')
    for (const d of [addDays(TODAY, -1), addDays(TODAY, -3)]) {
      const f = path.join(dir, `${d}.json`)
      fs.writeFileSync(f, '{"sentinel":true}')
      fs.utimesSync(f, past, past)
    }
    const res = runActivityDigest({ catchUp: true }, opts())
    expect(fs.existsSync(path.join(dir, `${addDays(TODAY, -2)}.json`))).toBe(true)
    for (const d of [addDays(TODAY, -1), addDays(TODAY, -3)]) {
      const f = path.join(dir, `${d}.json`)
      expect(fs.statSync(f).mtimeMs).toBe(past.getTime())
      expect(fs.readFileSync(f, 'utf8')).toBe('{"sentinel":true}')
    }
    expect(res.kept).toEqual([addDays(TODAY, -3), addDays(TODAY, -1)])
    expect(fs.existsSync(path.join(dir, `${TODAY}.json`))).toBe(false)
  })

  it('counts completed sessions that ended inside the local day, and history rows', () => {
    db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', 'C:/nowhere')").run()
    const ins = db.prepare(
      "INSERT INTO sessions (id, project_id, started_at, ended_at, status) VALUES (?, 'p', '2026-09-24T00:00:00Z', ?, ?)"
    )
    ins.run('s1', '2026-09-25T02:00:00.000Z', 'completed')
    ins.run('s2', '2026-09-24T16:30:00.000Z', 'completed') // 23:30 local on the 24th
    ins.run('s3', null, 'active')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(home, '.claude', 'history.jsonl'),
      [Date.parse('2026-09-25T03:00:00Z'), Date.parse('2026-09-24T03:00:00Z')]
        .map((t) => JSON.stringify({ timestamp: t }))
        .join('\n')
    )
    runActivityDigest({ date: DATE }, opts())
    const d = JSON.parse(
      fs.readFileSync(path.join(activityDir(artifactsDir), `${DATE}.json`), 'utf8')
    )
    expect(d.metrics.sessionsCompleted).toBe(1)
    expect(d.sources.historyRows).toBe(1)
  })

  it('works with no DB and no ~/.claude at all', () => {
    const res = runActivityDigest({ date: DATE }, opts({ db: null }))
    expect(res.written).toHaveLength(1)
    expect(res.written[0].prompts).toBe(0)
  })
})
