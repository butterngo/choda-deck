import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { buildSync } from 'esbuild'

// TASK-2151 — the real CLI bundle, spawned as a child process, so CHODA_DATA_DIR
// and the process cwd are exercised exactly as a scheduled task would see them.

const repoRoot = path.resolve(__dirname, '../../..')
let tmp: string
let bundle: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-cli-'))
  // The bundle must live inside the repo tree: the CLI loads better-sqlite3 via a
  // dynamic import(), which resolves like ESM and ignores NODE_PATH.
  const cacheDir = path.join(repoRoot, 'node_modules', '.cache')
  fs.mkdirSync(cacheDir, { recursive: true })
  bundle = path.join(fs.mkdtempSync(path.join(cacheDir, 'activity-cli-')), 'cli.cjs')
  buildSync({
    entryPoints: [path.join(repoRoot, 'src/adapters/cli/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'silent',
    // Mirrors package.json build:cli — playwright (TASK-2356) resolves its
    // browsers and optional deps at runtime, so it is never bundled.
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

function run(args: string[], cwd: string, dataDir: string) {
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CHODA_DATA_DIR: dataDir,
      CHODA_DB_PATH: '',
      HOME: home,
      USERPROFILE: home
    }
  })
}

describe('choda-deck activity — TASK-2151', () => {
  it('AC-5: writes under CHODA_DATA_DIR and creates nothing under <cwd>/data', () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'))
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'))
    const res = run(['activity', 'digest', '--date', '2026-09-25'], cwd, dataDir)
    expect(res.status).toBe(0)
    expect(fs.existsSync(path.join(dataDir, 'artifacts', 'activity', '2026-09-25.json'))).toBe(true)
    expect(fs.existsSync(path.join(cwd, 'data'))).toBe(false)
  })

  it('AC-6: an unknown subcommand exits 2 and names it on stderr', () => {
    const res = run(['activity', 'frobnicate'], tmp, path.join(tmp, 'unused'))
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('"frobnicate"')
  })

  it('an impossible --date exits 2 without writing', () => {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'))
    const res = run(['activity', 'digest', '--date', '2026-02-30'], tmp, dataDir)
    expect(res.status).toBe(2)
    expect(fs.existsSync(path.join(dataDir, 'artifacts'))).toBe(false)
  })
})

// TASK-3127 — `activity week` against a data dir holding a minimal DB and two digests.
describe('choda-deck activity week — TASK-3127', () => {
  function seed(): string {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'week-'))
    fs.mkdirSync(path.join(dataDir, 'database'), { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(path.join(dataDir, 'database', 'choda-deck.db'))
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, cwd TEXT);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, label TEXT, cwd TEXT, archived_at TEXT);`)
    const projects = ['juvenis-maxime', 'ba-nghiep', 'mavue-studio', 'tms', 'choda-deck']
    for (const id of projects) {
      db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(id, id, `C:\\dev\\${id}`)
    }
    db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, NULL)').run(
      'BE',
      'tms',
      'BE',
      'C:\\dev\\test\\tms'
    )
    db.close()
    const act = path.join(dataDir, 'artifacts', 'activity')
    fs.mkdirSync(act, { recursive: true })
    const day = (rows: { workspace: string; activeMinutes: number }[]) =>
      JSON.stringify({ metrics: { byProject: rows } })
    fs.writeFileSync(
      path.join(act, '2026-11-03.json'),
      day([
        { workspace: 'c:/dev/mavue-studio', activeMinutes: 200 },
        { workspace: 'c:/dev/test/tms', activeMinutes: 90 }
      ])
    )
    fs.writeFileSync(
      path.join(act, '2026-11-04.json'),
      day([
        { workspace: 'c:/dev/mavue-studio.worktrees/autopilot-task-3039', activeMinutes: 100 },
        { workspace: 'c:/dev/test/workshop-mobile', activeMinutes: 61 }
      ])
    )
    return dataDir
  }

  it('--json prints week, limit, active sorted by minutes, and picked null without a pick', () => {
    const dataDir = seed()
    const res = run(['activity', 'week', '--week', '2026-W45', '--json'], tmp, dataDir)
    expect(res.status).toBe(0)
    expect(JSON.parse(res.stdout)).toEqual({
      week: '2026-W45',
      limit: 4,
      active: [
        { projectId: 'mavue-studio', minutes: 300, registered: true },
        { projectId: 'tms', minutes: 90, registered: true },
        { projectId: 'unregistered:c:/dev/test/workshop-mobile', minutes: 61, registered: false }
      ],
      picked: null
    })
  })

  it('pick writes week-<W>.json and the next report returns the picked ids', () => {
    const dataDir = seed()
    const ids = ['juvenis-maxime', 'ba-nghiep', 'mavue-studio', 'tms']
    const pick = run(['activity', 'week', 'pick', ...ids, '--week', '2026-W45'], tmp, dataDir)
    expect(pick.status).toBe(0)
    const file = path.join(dataDir, 'artifacts', 'activity', 'week-2026-W45.json')
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).picked).toEqual(ids)
    const res = run(['activity', 'week', '--week', '2026-W45', '--json'], tmp, dataDir)
    expect(JSON.parse(res.stdout).picked).toEqual(ids)
  })

  it('pick with 5 ids exits 1 naming rule 1 and writes no file', () => {
    const dataDir = seed()
    const ids = ['juvenis-maxime', 'ba-nghiep', 'mavue-studio', 'tms', 'choda-deck']
    const res = run(['activity', 'week', 'pick', ...ids, '--week', '2026-W45'], tmp, dataDir)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('rule 1')
    expect(fs.existsSync(path.join(dataDir, 'artifacts', 'activity', 'week-2026-W45.json'))).toBe(
      false
    )
  })

  it('pick with an unregistered id exits 1 naming that id', () => {
    const dataDir = seed()
    const res = run(
      ['activity', 'week', 'pick', 'tms', 'no-such', '--week', '2026-W45'],
      tmp,
      dataDir
    )
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('"no-such"')
  })
})

// TASK-3129 — `rules check` exit codes and JSON shape, and `activity week swap` from the CLI.
describe('choda-deck rules check / activity week swap — TASK-3129', () => {
  function seedRules(): string {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'rules-'))
    fs.mkdirSync(path.join(dataDir, 'database'), { recursive: true })
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(path.join(dataDir, 'database', 'choda-deck.db'))
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, cwd TEXT);
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, project_id TEXT, label TEXT, cwd TEXT, archived_at TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT);`)
    // cwds that do not exist, so gh never reaches a real repo
    for (const id of ['alpha', 'beta', 'gamma']) {
      db.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(
        id,
        id,
        path.join(dataDir, 'nope', id)
      )
    }
    db.prepare("INSERT INTO tasks VALUES ('TASK-5', 'beta', 'IMPLEMENTED')").run()
    db.close()
    return dataDir
  }

  it('prints { projectId, week, verdict, reasons } and exits 0 on pass, 3 on blocked', () => {
    const dataDir = seedRules()
    expect(
      run(['activity', 'week', 'pick', 'alpha', 'beta', '--week', '2026-W45'], tmp, dataDir).status
    ).toBe(0)

    const pass = run(['rules', 'check', 'alpha', '--week', '2026-W45', '--json'], tmp, dataDir)
    expect(pass.status).toBe(0)
    expect(JSON.parse(pass.stdout)).toMatchObject({
      projectId: 'alpha',
      week: '2026-W45',
      verdict: 'pass',
      reasons: []
    })

    const blocked = run(['rules', 'check', 'gamma', '--week', '2026-W45', '--json'], tmp, dataDir)
    expect(blocked.status).toBe(3)
    const out = JSON.parse(blocked.stdout)
    expect(out.verdict).toBe('blocked')
    expect(out.reasons[0]).toMatchObject({ rule: 1 })

    const implemented = run(
      ['rules', 'check', 'beta', '--week', '2026-W45', '--json'],
      tmp,
      dataDir
    )
    expect(implemented.status).toBe(3)
    expect(JSON.parse(implemented.stdout).reasons[0].message).toContain('TASK-5')
  })

  it('swap refuses an unclean <out> with exit 3, and --override records the reason', () => {
    const dataDir = seedRules()
    run(['activity', 'week', 'pick', 'alpha', 'beta', '--week', '2026-W45'], tmp, dataDir)
    const refused = run(
      ['activity', 'week', 'swap', 'beta', 'gamma', '--week', '2026-W45'],
      tmp,
      dataDir
    )
    expect(refused.status).toBe(3)
    expect(refused.stderr).toContain('TASK-5')

    const forced = run(
      ['activity', 'week', 'swap', 'beta', 'gamma', '--override', 'paused', '--week', '2026-W45'],
      tmp,
      dataDir
    )
    expect(forced.status).toBe(0)
    const pick = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'artifacts', 'activity', 'week-2026-W45.json'), 'utf8')
    )
    expect(pick.picked).toEqual(['alpha', 'gamma'])
    expect(pick.swaps[0]).toMatchObject({ out: 'beta', in: 'gamma', override: 'paused' })
  })
})
