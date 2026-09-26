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
    external: [
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
