#!/usr/bin/env node
/**
 * Smoke test harness for dist/cli.cjs and dist/mcp-server.cjs bundles.
 *
 * Run after: pnpm run build  (or pnpm run build:mcp && pnpm run build:cli)
 *
 * Uses CHODA_DATA_DIR=<tmp> per run so it never touches shared state.
 */
import { spawnSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const CLI = path.join(root, 'dist', 'cli.cjs')
const MCP = path.join(root, 'dist', 'mcp-server.cjs')

for (const bin of [CLI, MCP]) {
  if (!fs.existsSync(bin)) {
    process.stderr.write(`error: bundle not found: ${bin}\n  Run 'pnpm run build' first.\n`)
    process.exit(1)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'choda-smoke-'))

let passed = 0
let failed = 0

function check(label, ok, detail) {
  if (ok) {
    process.stdout.write(`PASS [${label}]\n`)
    passed++
  } else {
    process.stderr.write(`FAIL [${label}]${detail ? `: ${detail}` : ''}\n`)
    failed++
  }
}

function runCli(args, { expectExit = 0, expectOutput = [] } = {}) {
  const label = `node dist/cli.cjs ${args.join(' ')}`
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, CHODA_DATA_DIR: tmpDir },
    encoding: 'utf8',
    timeout: 15_000,
  })
  const combined = (result.stdout ?? '') + (result.stderr ?? '')

  if (result.status !== expectExit) {
    check(label, false, `exit ${result.status ?? 'null'} (expected ${expectExit})\n  output: ${combined.slice(0, 300)}`)
    return
  }
  for (const needle of expectOutput) {
    if (!combined.includes(needle)) {
      check(label, false, `output missing "${needle}"\n  got: ${combined.slice(0, 300)}`)
      return
    }
  }
  check(label, true)
}

// Case 1: top-level --help exit 0, mcp serve subcommand mentioned
runCli(['--help'], {
  expectExit: 0,
  expectOutput: ['mcp serve'],
})

// Case 2: unknown subcommand → exit 2
runCli(['queue'], { expectExit: 2 })

// Case 3: MCP server responds to JSON-RPC initialize
await smokeMcp()

// Cleanup temp dir
try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch {
  // best-effort
}

if (failed > 0) {
  process.stderr.write(`\n${failed} smoke case(s) FAILED\n`)
  process.exit(1)
}
process.stdout.write(`\nAll ${passed} smoke cases PASSED\n`)

// ---------------------------------------------------------------------------

function smokeMcp() {
  const label = 'node dist/mcp-server.cjs (JSON-RPC initialize)'
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MCP], {
      env: { ...process.env, CHODA_DATA_DIR: tmpDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const initMsg =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0' },
        },
      }) + '\n'

    let stdout = ''
    let resolved = false

    const done = (ok, detail) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      child.kill()
      check(label, ok, detail)
      resolve(undefined)
    }

    const timer = setTimeout(() => {
      done(false, `timeout — no "result" received\n  stdout so far: ${stdout.slice(0, 300)}`)
    }, 10_000)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.includes('"result"')) done(true)
    })

    child.on('close', () => {
      if (!resolved) done(false, `process closed without "result"\n  stdout: ${stdout.slice(0, 300)}`)
    })

    child.on('error', (err) => done(false, err.message))

    child.stdin.write(initMsg)
  })
}
