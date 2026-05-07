#!/usr/bin/env node
/**
 * Post-build smoke for choda-deck CLI v1 (AC5).
 *
 * Runs all phase-1 read commands against the data store referenced by
 * CHODA_DATA_DIR + CHODA_CONTENT_ROOT (caller-provided; defaults to repo data/).
 *
 * Asserts per command:
 *   - exit code 0
 *   - --json mode returns valid JSON
 *   - plain mode returns non-empty human-readable output
 *
 * Captures `task list --json` performance baseline (AC1).
 *
 * Discovers IDs dynamically (no fixture coupling) — task show / knowledge show /
 * project context use the first entry returned by their list command. If a list
 * is empty, the corresponding show is skipped (logged as SKIP).
 */

import { spawn, spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import * as path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI_BIN = path.join(REPO_ROOT, 'dist', 'cli.cjs')
const PERF_BUDGET_MS = 250

const ENV = {
  ...process.env,
  CHODA_DATA_DIR: process.env.CHODA_DATA_DIR ?? path.join(REPO_ROOT, 'data'),
  CHODA_CONTENT_ROOT:
    process.env.CHODA_CONTENT_ROOT ?? path.join(REPO_ROOT, 'data', 'content')
}

const results = []
let failures = 0

function run(label, args, { expectExit = 0 } = {}) {
  const t0 = performance.now()
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    env: ENV,
    encoding: 'utf-8'
  })
  const ms = Math.round(performance.now() - t0)
  const exit = res.status ?? -1
  const stdout = res.stdout ?? ''
  const stderr = res.stderr ?? ''
  const ok = exit === expectExit
  results.push({ label, args, exit, expectExit, ms, ok, stdout, stderr })
  if (!ok) failures++
  return { exit, stdout, stderr, ms, ok }
}

function assert(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`)
  } else {
    console.error(`  FAIL  ${label}: ${detail}`)
    failures++
  }
}

function assertJson(label, raw) {
  try {
    JSON.parse(raw)
    console.log(`  PASS  ${label}`)
  } catch (err) {
    console.error(`  FAIL  ${label}: ${err.message}`)
    failures++
  }
}

function header(name) {
  console.log(`\n=== ${name} ===`)
}

async function smokeMcpServe() {
  const initMsg = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1' }
    }
  })

  const proc = spawn(process.execPath, [CLI_BIN, 'mcp', 'serve'], { env: ENV })
  let stdout = ''
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf-8')
  })
  proc.stdin.write(initMsg + '\n')

  await new Promise((resolve) => setTimeout(resolve, 1500))
  proc.kill('SIGTERM')

  await new Promise((resolve) => proc.on('exit', resolve))

  let parsed
  try {
    parsed = JSON.parse(stdout.split('\n').find((l) => l.trim().length > 0) ?? '')
  } catch (err) {
    console.error(`  FAIL  mcp serve initialize parse: ${err.message}`)
    failures++
    return
  }
  assert('mcp serve responds with jsonrpc 2.0', parsed.jsonrpc === '2.0',
    `got jsonrpc=${parsed.jsonrpc}`)
  assert('mcp serve initialize result.protocolVersion present',
    typeof parsed.result?.protocolVersion === 'string',
    `protocolVersion missing`)
  assert('mcp serve advertises tools capability',
    parsed.result?.capabilities?.tools !== undefined,
    `tools capability missing`)
}

// --- meta -------------------------------------------------------------------
header('meta')
const ver = run('--version', ['--version'])
assert('--version exit 0', ver.ok, `exit=${ver.exit}`)
assert('--version output non-empty', ver.stdout.trim().length > 0, 'empty stdout')

const help = run('--help', ['--help'])
assert('--help exit 0', help.ok, `exit=${help.exit}`)
assert('--help mentions Core read commands', help.stdout.includes('Core read commands'),
  'missing section header')
assert('--help mentions MCP server', help.stdout.includes('MCP server'), 'missing section header')

// --- task list --------------------------------------------------------------
header('task list')
const tlPlain = run('task list --status TODO plain', ['task', 'list', '--status', 'TODO'])
assert('task list plain exit 0', tlPlain.ok, `exit=${tlPlain.exit} stderr=${tlPlain.stderr}`)
assert('task list plain non-empty', tlPlain.stdout.trim().length > 0, 'empty stdout')

const tlJson = run('task list --status TODO --json', [
  'task', 'list', '--status', 'TODO', '--json'
])
assert('task list json exit 0', tlJson.ok, `exit=${tlJson.exit}`)
assertJson('task list json valid', tlJson.stdout)

const perfPlain = run('task list perf', [
  'task', 'list', '--status', 'TODO', '--json'
])
console.log(`  PERF  task list --json: ${perfPlain.ms}ms (budget ${PERF_BUDGET_MS}ms)`)
assert(`task list perf < ${PERF_BUDGET_MS}ms`, perfPlain.ms < PERF_BUDGET_MS,
  `${perfPlain.ms}ms exceeds budget`)

// --- task show (discover ID) -----------------------------------------------
header('task show')
let taskId = null
try {
  const tasks = JSON.parse(tlJson.stdout)
  if (Array.isArray(tasks) && tasks.length > 0) taskId = tasks[0].id
} catch { /* covered by parity assert above */ }

if (!taskId) {
  console.log('  SKIP  no TODO task available to show')
} else {
  const tsPlain = run(`task show ${taskId}`, ['task', 'show', taskId])
  assert('task show plain exit 0', tsPlain.ok, `exit=${tsPlain.exit}`)
  assert('task show plain non-empty', tsPlain.stdout.trim().length > 0, 'empty stdout')

  const tsJson = run(`task show ${taskId} --json`, ['task', 'show', taskId, '--json'])
  assert('task show json exit 0', tsJson.ok, `exit=${tsJson.exit}`)
  assertJson('task show json valid', tsJson.stdout)
}

// --- inbox list -------------------------------------------------------------
header('inbox list')
const ilPlain = run('inbox list plain', ['inbox', 'list'])
assert('inbox list plain exit 0', ilPlain.ok, `exit=${ilPlain.exit}`)

const ilJson = run('inbox list --json', ['inbox', 'list', '--json'])
assert('inbox list json exit 0', ilJson.ok, `exit=${ilJson.exit}`)
assertJson('inbox list json valid', ilJson.stdout)

// --- knowledge list + show --------------------------------------------------
header('knowledge list + show')
const klPlain = run('knowledge list plain', ['knowledge', 'list'])
assert('knowledge list plain exit 0', klPlain.ok, `exit=${klPlain.exit}`)

const klJson = run('knowledge list --json', ['knowledge', 'list', '--json'])
assert('knowledge list json exit 0', klJson.ok, `exit=${klJson.exit}`)
assertJson('knowledge list json valid', klJson.stdout)

let knowledgeSlug = null
try {
  const items = JSON.parse(klJson.stdout)
  if (Array.isArray(items) && items.length > 0) knowledgeSlug = items[0].slug
} catch { /* covered above */ }

if (!knowledgeSlug) {
  console.log('  SKIP  no knowledge entry available to show')
} else {
  const ksPlain = run(`knowledge show ${knowledgeSlug}`, ['knowledge', 'show', knowledgeSlug])
  assert('knowledge show plain exit 0', ksPlain.ok, `exit=${ksPlain.exit}`)
  assert('knowledge show plain non-empty', ksPlain.stdout.trim().length > 0, 'empty stdout')

  const ksJson = run(`knowledge show ${knowledgeSlug} --json`,
    ['knowledge', 'show', knowledgeSlug, '--json'])
  assert('knowledge show json exit 0', ksJson.ok, `exit=${ksJson.exit}`)
  assertJson('knowledge show json valid', ksJson.stdout)
}

// --- project context (discover projectId from task list) -------------------
header('project context')
let projectId = null
try {
  const tasks = JSON.parse(tlJson.stdout)
  if (Array.isArray(tasks) && tasks.length > 0) projectId = tasks[0].projectId
} catch { /* covered above */ }

if (!projectId) {
  console.log('  SKIP  no project available')
} else {
  const pcPlain = run(`project context ${projectId}`, ['project', 'context', projectId])
  assert('project context plain exit 0', pcPlain.ok, `exit=${pcPlain.exit}`)
  assert('project context plain non-empty', pcPlain.stdout.trim().length > 0, 'empty stdout')

  const pcJson = run(`project context ${projectId} --json`,
    ['project', 'context', projectId, '--json'])
  assert('project context json exit 0', pcJson.ok, `exit=${pcJson.exit}`)
  assertJson('project context json valid', pcJson.stdout)
}

// --- mcp serve initialize handshake ----------------------------------------
header('mcp serve')
await smokeMcpServe()

// --- error path: missing required arg --------------------------------------
header('error paths')
const noStatus = run('task list (missing --status)', ['task', 'list'], { expectExit: 2 })
assert('missing --status exits 2', noStatus.ok, `exit=${noStatus.exit}`)
assert('missing --status writes error', noStatus.stderr.includes('--status is required'),
  'expected stderr to mention --status')

// --- summary ----------------------------------------------------------------
header('summary')
const total = results.length
const passed = results.filter((r) => r.ok).length
console.log(`  ${passed}/${total} command runs ok, failures: ${failures}`)
console.log(`  perf baseline (task list --json): ${perfPlain.ms}ms`)

process.exit(failures > 0 ? 1 : 0)
