import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import { initSchema } from '../../core/domain/repositories/schema'

// TASK-2312 — `choda-deck session reconcile` through the real CLI bundle, against
// a fixture DB under CHODA_DATA_DIR and a fixture git repo as the workspace cwd.

const repoRoot = path.resolve(__dirname, '../../..')
const DAY = 24 * 60 * 60 * 1000
let tmp: string
let bundle: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cli-'))
  // Inside the repo tree, so the dynamic import() of better-sqlite3 resolves.
  const cacheDir = path.join(repoRoot, 'node_modules', '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  bundle = path.join(fs.mkdtempSync(path.join(cacheDir, 'session-cli-')), 'cli.cjs')
  buildSync({
    entryPoints: [path.join(repoRoot, 'src/adapters/cli/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    external: [
      'playwright',
      'better-sqlite3',
      'sqlite-vec',
      '@huggingface/transformers',
      'onnxruntime-node',
      'onnxruntime-web',
      'sharp',
      'node-pty'
    ]
  })
}, 60_000)

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.rmSync(path.dirname(bundle), { recursive: true, force: true })
})

function gitRepo(dir: string, subjects: string[]): void {
  fs.mkdirSync(dir, { recursive: true })
  const g = (args: string[]): void => {
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      stdio: 'ignore'
    })
  }
  g(['init', '-q', '-b', 'main'])
  subjects.forEach((s, i) => {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i))
    g(['add', '.'])
    g(['commit', '-q', '-m', s])
  })
  g(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  g(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
}

interface Fixture {
  dataDir: string
  dbPath: string
}

/** Four ACTIVE sessions; only OLD-MERGED is both older than 3 days and merged. */
function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(tmp, 'case-'))
  const repo = path.join(root, 'repo')
  gitRepo(repo, [
    'Merge pull request #12 from u/feat/task-101-thing',
    'feat: squash-merged (TASK-102) (#13)',
    'chore: direct push naming TASK-103'
  ])
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(dataDir, 'database'), { recursive: true })
  const dbPath = path.join(dataDir, 'database', 'choda-deck.db')
  const db = new Database(dbPath)
  initSchema(db)
  db.prepare("INSERT INTO projects (id, name, cwd) VALUES ('p', 'P', ?)").run(repo)
  db.prepare("INSERT INTO workspaces (id, project_id, label, cwd) VALUES ('ws', 'p', 'ws', ?)").run(
    repo
  )
  const ins = db.prepare(
    "INSERT INTO sessions (id, project_id, workspace_id, task_id, started_at, status) VALUES (?, 'p', 'ws', ?, ?, 'active')"
  )
  const ago = (days: number): string => new Date(Date.now() - days * DAY).toISOString()
  ins.run('OLD-MERGED', 'TASK-101', ago(5)) // merge-commit branch name names it
  ins.run('YOUNG-MERGED', 'TASK-102', ago(1)) // merged, but only a day old
  ins.run('OLD-DIRECT', 'TASK-103', ago(5)) // named only by a direct push
  ins.run('OLD-OPEN', 'TASK-1010', ago(5)) // TASK-101 is a prefix, not this id
  db.close()
  return { dataDir, dbPath }
}

function run(args: string[], dataDir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, CHODA_DATA_DIR: dataDir, CHODA_DB_PATH: '' }
  })
}

function sessionRows(dbPath: string): unknown[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.prepare('SELECT * FROM sessions ORDER BY id').all()
  } finally {
    db.close()
  }
}

describe('choda-deck session reconcile — TASK-2312', () => {
  it('AC-3: prints the old merged session and nothing for a younger one', () => {
    const { dataDir } = fixture()
    const res = run(['session', 'reconcile'], dataDir)
    expect(res.status).toBe(0)
    const lines = String(res.stdout).trim().split('\n') // in-memory output, LF from the CLI
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^OLD-MERGED {2}TASK-101 /)
    expect(lines[0]).toContain('merged: Merge pull request #12')
    expect(String(res.stdout)).not.toContain('YOUNG-MERGED')
  })

  it('AC-4: performs no writes — every session row is unchanged after the run', () => {
    const { dataDir, dbPath } = fixture()
    const before = sessionRows(dbPath)
    expect(run(['session', 'reconcile'], dataDir).status).toBe(0)
    expect(sessionRows(dbPath)).toEqual(before)
  })

  it('an unknown subcommand exits 2 and names it', () => {
    const res = run(['session', 'close'], path.join(tmp, 'unused'))
    expect(res.status).toBe(2)
    expect(String(res.stderr)).toContain('unknown session subcommand "close"')
  })
})
