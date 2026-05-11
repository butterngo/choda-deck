// TASK-537 — Validate headless `claude -p` spawn contract for HarnessRunner
// Throwaway spike per ADR-014. Matches convention of spike-pty.mjs (.mjs, no TS).
// Run: node scripts/spike-harness-headless.mjs
// WARNING: spawns real `claude -p` — estimated total cost < $0.50.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const MARKER_INNER = 'spike-marker-inner-abc123'
const MARKER_OUTER = 'spike-marker-outer-xyz789'
const MARKER_SETTING = 'spike-setting-marker-qwe456'

// Windows: Node 20+ blocks spawning .cmd without shell:true (CVE-2024-27980).
// shell:true concatenates args w/o escaping — we build the full command string ourselves
// with cmd.exe-safe quoting and pipe prompt via stdin to avoid argv mangling of prompt.
const CLAUDE_CMD = process.platform === 'win32'
  ? '"C:\\Users\\hngo1_mantu\\AppData\\Roaming\\npm\\claude.cmd"'
  : 'claude'

function quoteArg(a) {
  // Wrap any arg containing cmd.exe metachars in double-quotes; escape inner quotes.
  if (/[\s()<>&|^"*?]/.test(a)) return `"${a.replace(/"/g, '\\"')}"`
  return a
}
const MODEL = 'sonnet'
const DEFAULT_TIMEOUT_MS = 120_000
const BUDGET_TEST_TIMEOUT_MS = 180_000

const root = mkdtempSync(join(tmpdir(), 'choda-spike-'))
const workspace = join(root, 'workspace')
const settingsDir = join(workspace, '.claude')
mkdirSync(workspace, { recursive: true })
mkdirSync(settingsDir, { recursive: true })

writeFileSync(
  join(root, 'CLAUDE.md'),
  `# Outer project context\n\n## Fact: parent marker is \`${MARKER_OUTER}\`\n`,
)
writeFileSync(
  join(workspace, 'CLAUDE.md'),
  `# Workspace context\n\n## Fact: workspace marker is \`${MARKER_INNER}\`\n\nThe phrase \`${MARKER_INNER}\` is the canonical inner marker for this spike. If asked what the marker is, reply with exactly that string.\n`,
)
writeFileSync(
  join(workspace, 'sample.txt'),
  Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: lorem ipsum data ${i}`).join('\n'),
)
writeFileSync(
  join(settingsDir, 'settings.local.json'),
  JSON.stringify({ env: { SPIKE_SETTING_MARKER: MARKER_SETTING } }, null, 2),
)

function spawnClaude({ args, prompt, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const fullArgs = [
      '-p',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--no-session-persistence',
      ...args,
    ]
    const cmdLine = `${CLAUDE_CMD} ${fullArgs.map(quoteArg).join(' ')}`
    const argvBytes = Buffer.byteLength(cmdLine, 'utf8')
    const started = Date.now()
    const child = spawn(cmdLine, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    if (prompt) {
      child.stdin.write(prompt)
      child.stdin.end()
    } else {
      child.stdin.end()
    }
    let stdout = ''
    let stderr = ''
    let killedByTimeout = false
    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        argvBytes,
        killedByTimeout,
      })
    })
  })
}

function parseResult(stdout) {
  try {
    const parsed = JSON.parse(stdout)
    return { ok: true, parsed }
  } catch (err) {
    return { ok: false, error: err.message, raw: stdout.slice(0, 500) }
  }
}

function verdict(pass, evidence) {
  return { pass, evidence }
}

function shorten(s, n = 200) {
  if (!s) return ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

const results = []
const log = (msg) => console.log(`[spike] ${msg}`)

async function test1_claudeMdDiscovery() {
  log('Test 1: CLAUDE.md auto-discovery + walk-up scope')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Read the workspace CLAUDE.md and the outer/parent CLAUDE.md (if any is auto-loaded via upward discovery). Reply as JSON on a single line: {"innerMarker": "<value or null>", "outerMarker": "<value or null>"}. Do not use tools; rely only on memory already loaded from CLAUDE.md files.`,
    args: ['--permission-mode', 'default'],
  })
  const parsed = parseResult(r.stdout)
  let innerSeen = false
  let outerSeen = false
  if (parsed.ok) {
    const resultText = parsed.parsed?.result || ''
    innerSeen = resultText.includes(MARKER_INNER)
    outerSeen = resultText.includes(MARKER_OUTER)
  } else {
    innerSeen = r.stdout.includes(MARKER_INNER)
    outerSeen = r.stdout.includes(MARKER_OUTER)
  }
  results.push({
    id: 1,
    name: 'CLAUDE.md auto-discovery',
    ...verdict(
      innerSeen,
      `inner=${innerSeen} outer=${outerSeen} — ${outerSeen ? 'WALKS UP parent tree' : 'scoped to cwd only'} | exit=${r.code} dur=${r.durationMs}ms argv=${r.argvBytes}B`,
    ),
    extra: { innerSeen, outerSeen, parsedOk: parsed.ok, resultPreview: shorten(parsed.parsed?.result) },
  })
}

async function test2_allowedToolsBlock() {
  log('Test 2: --allowed-tools allow-list blocks disallowed tool')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Use the Bash tool to run: echo blocked-tool-attempt. Then tell me what happened in JSON: {"bashRan": true|false, "reason": "<why>"}`,
    args: ['--allowed-tools', 'Read Grep Glob', '--permission-mode', 'default'],
    timeoutMs: 60_000,
  })
  const parsed = parseResult(r.stdout)
  const text = parsed.parsed?.result || r.stdout
  const ranUnrestricted = text.includes('blocked-tool-attempt') && /bashRan\s*:\s*true/i.test(text)
  const blocked = !ranUnrestricted
  results.push({
    id: 2,
    name: '--allowed-tools blocks Bash',
    ...verdict(
      blocked,
      `bashBlocked=${blocked} | exit=${r.code} dur=${r.durationMs}ms | result: ${shorten(text, 250)}`,
    ),
  })
}

async function test3_bashSubcommandScope() {
  log('Test 3: --allowed-tools Bash(git *) scope')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Try to run two bash commands and report JSON {"gitStatusRan": true|false, "curlRan": true|false}: (1) "git status --porcelain" (2) "curl https://example.com". Actually attempt both via the Bash tool.`,
    args: ['--allowed-tools', 'Bash(git *)', '--permission-mode', 'default'],
    timeoutMs: 90_000,
  })
  const parsed = parseResult(r.stdout)
  const text = parsed.parsed?.result || r.stdout
  const gitAllowed = /gitStatusRan\s*:\s*true/i.test(text)
  const curlDenied = /curlRan\s*:\s*false/i.test(text) || /curl.*(den|block|not allow|permission)/i.test(text)
  const pass = gitAllowed && curlDenied
  results.push({
    id: 3,
    name: 'Bash(git *) subcommand scope',
    ...verdict(
      pass,
      `gitAllowed=${gitAllowed} curlDenied=${curlDenied} | exit=${r.code} dur=${r.durationMs}ms | result: ${shorten(text, 250)}`,
    ),
  })
}

async function test4_budgetCap() {
  log('Test 4: --max-budget-usd cap + abort')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Read sample.txt line by line using many separate Read tool invocations. For each line, write a detailed 100-word analysis. Keep going — do not stop, do not summarize early.`,
    args: ['--max-budget-usd', '0.02', '--allowed-tools', 'Read', '--permission-mode', 'default'],
    timeoutMs: BUDGET_TEST_TIMEOUT_MS,
  })
  const parsed = parseResult(r.stdout)
  const cost = parsed.parsed?.total_cost_usd ?? null
  const capped = (cost !== null && cost <= 0.1) || /budget/i.test(r.stderr) || r.code !== 0
  results.push({
    id: 4,
    name: '--max-budget-usd cap',
    ...verdict(
      capped,
      `exit=${r.code} killedByTimeout=${r.killedByTimeout} cost=${cost} stderr: ${shorten(r.stderr, 200)}`,
    ),
    extra: { cost, stderrSample: shorten(r.stderr, 400) },
  })
}

async function test5_jsonOutputParse() {
  log('Test 5: --output-format json parse')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Reply with the word: hello-json.`,
    args: ['--permission-mode', 'default'],
    timeoutMs: 60_000,
  })
  const parsed = parseResult(r.stdout)
  const fields = parsed.ok
    ? {
        hasResult: typeof parsed.parsed?.result === 'string',
        hasCost: typeof parsed.parsed?.total_cost_usd === 'number',
        hasDuration: typeof parsed.parsed?.duration_ms === 'number',
        hasUsage: !!parsed.parsed?.usage,
      }
    : null
  const pass = parsed.ok && fields && fields.hasResult
  results.push({
    id: 5,
    name: '--output-format json parse',
    ...verdict(
      pass,
      `parsed=${parsed.ok} fields=${JSON.stringify(fields)} exit=${r.code} dur=${r.durationMs}ms`,
    ),
    extra: { fields, preview: shorten(r.stdout, 300) },
  })
}

async function test6_permissionBehavior() {
  log('Test 6: permission prompt behavior in -p (no --permission-mode override)')
  // Spawn with Bash NOT in allowlist, ask to run it. Observe: hang until timeout? auto-deny? exit?
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Run Bash command "echo permission-probe". If blocked, say DENIED. Reply JSON {"outcome": "ran"|"denied"|"other"}.`,
    args: ['--allowed-tools', 'Read'],
    timeoutMs: 45_000,
  })
  const parsed = parseResult(r.stdout)
  const text = parsed.parsed?.result || r.stdout
  const outcome = r.killedByTimeout
    ? 'HANG (timeout)'
    : /denied/i.test(text) || /permission/i.test(text)
      ? 'DENIED'
      : /ran/i.test(text)
        ? 'RAN (unexpected)'
        : 'OTHER'
  const pass = outcome !== 'HANG (timeout)'
  results.push({
    id: 6,
    name: 'Permission behavior in -p',
    ...verdict(
      pass,
      `outcome=${outcome} exit=${r.code} dur=${r.durationMs}ms | result: ${shorten(text, 250)}`,
    ),
    extra: { outcome },
  })
}

async function test7_settingLeakage() {
  log('Test 7: setting leakage via cwd (.claude/settings.local.json env)')
  const run = async (extraArgs, label) => {
    const r = await spawnClaude({
      cwd: workspace,
      prompt: `Reply JSON {"marker": "<value of $SPIKE_SETTING_MARKER env or null>"}. Try to learn the env var by running Bash printenv SPIKE_SETTING_MARKER.`,
      args: ['--allowed-tools', 'Bash(printenv *) Bash(echo *)', '--permission-mode', 'default', ...extraArgs],
      timeoutMs: 60_000,
    })
    const parsed = parseResult(r.stdout)
    const text = parsed.parsed?.result || r.stdout
    const leaked = text.includes(MARKER_SETTING)
    return { label, leaked, exit: r.code, preview: shorten(text, 200) }
  }
  const defaultRun = await run([], 'default')
  const userOnlyRun = await run(['--setting-sources', 'user'], 'user-only')
  const pass =
    defaultRun.leaked !== userOnlyRun.leaked ||
    (!defaultRun.leaked && !userOnlyRun.leaked)
  results.push({
    id: 7,
    name: 'Setting leakage via cwd',
    ...verdict(
      pass,
      `default.leaked=${defaultRun.leaked} userOnly.leaked=${userOnlyRun.leaked} — ${defaultRun.leaked ? 'NEEDS --setting-sources user for hermetic spawn' : 'no leak observed by default'}`,
    ),
    extra: { defaultRun, userOnlyRun },
  })
}

async function test8_toolsRestriction() {
  log('Test 8: --tools "Read,Grep,Glob" actually loads-only (blocks Bash via non-availability)')
  const r = await spawnClaude({
    cwd: workspace,
    prompt: `Attempt to run Bash with command "echo tools-restrict-probe". If the Bash tool is not available, say UNAVAILABLE. Reply as JSON on ONE line: {"bashAttempted":true|false,"bashAvailable":true|false,"note":"<why>"}`,
    args: ['--tools', 'Read,Grep,Glob', '--permission-mode', 'default'],
    timeoutMs: 60_000,
  })
  const parsed = parseResult(r.stdout)
  const text = parsed.parsed?.result || r.stdout
  const available = /bashAvailable\s*:\s*true/i.test(text)
  const ranEcho = text.includes('tools-restrict-probe') && /bashAttempted\s*:\s*true/i.test(text)
  const restricted = !available && !ranEcho
  results.push({
    id: 8,
    name: '--tools limits loaded tool set',
    ...verdict(
      restricted,
      `restricted=${restricted} bashAvailable=${available} ranEcho=${ranEcho} exit=${r.code} dur=${r.durationMs}ms | result: ${shorten(text, 250)}`,
    ),
    extra: { available, ranEcho },
  })
}

async function test9_worktreeCwd() {
  log('Test 9: spawn with cwd = real git worktree')
  const worktreePath = 'C:\\dev\\choda-deck.worktrees\\task-537-spike'
  const expectedBranch = 'spike/task-537-headless-claude'
  const r = await spawnClaude({
    cwd: worktreePath,
    prompt: `You are in a git working tree. Run these two Bash commands via the Bash tool and capture their stdout: (1) "git rev-parse --show-toplevel" (2) "git branch --show-current". Also, read the CLAUDE.md at cwd if available and note whether it mentions the phrase "Choda Deck". Reply on ONE line as JSON: {"toplevel":"<path from command 1>","branch":"<branch from command 2>","claudeMdMentionsChodaDeck":true|false}`,
    args: [
      '--tools', 'Read,Grep,Bash',
      '--allowed-tools', 'Bash(git *)',
      '--permission-mode', 'default',
      '--setting-sources', 'user',
    ],
    timeoutMs: 90_000,
  })
  const parsed = parseResult(r.stdout)
  const text = parsed.parsed?.result || r.stdout
  const toplevelSeen =
    text.toLowerCase().includes('task-537-spike') ||
    text.toLowerCase().includes('choda-deck.worktrees')
  const branchSeen = text.includes(expectedBranch) || text.includes('task-537-headless-claude')
  const claudeMd = /claudeMdMentionsChodaDeck\s*:\s*true/i.test(text) || /choda deck/i.test(text)
  const pass = toplevelSeen && branchSeen && claudeMd
  results.push({
    id: 9,
    name: 'cwd = git worktree path',
    ...verdict(
      pass,
      `toplevelSeen=${toplevelSeen} branchSeen=${branchSeen} claudeMdOk=${claudeMd} exit=${r.code} dur=${r.durationMs}ms | result: ${shorten(text, 300)}`,
    ),
    extra: { toplevelSeen, branchSeen, claudeMd },
  })
}

function encodeCwdToCachePath(cwd) {
  // Claude encodes cwd by replacing : and \ and / with - (approx mirror of what we observe).
  // e.g. C:\Users\HNGO1_~1\AppData\Local\Temp\choda-spike-XXX\workspace →
  //      C--Users-HNGO1--1-AppData-Local-Temp-choda-spike-XXX-workspace
  const flat = cwd.replace(/[:\\/]/g, '-')
  return join(homedir(), '.claude', 'projects', flat)
}

function rawSpawnClaude(argsList, cwd, promptText, timeoutMs = 45_000) {
  return new Promise((resolve) => {
    const cmdLine = `${CLAUDE_CMD} ${argsList.map(quoteArg).join(' ')}`
    const child = spawn(cmdLine, { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.write(promptText)
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function test10_sessionPersistenceFlags() {
  log('Test 10: which flag combo actually prevents ~/.claude/projects/<cwd>/ cache dir?')
  const base = ['-p', '--model', MODEL, '--output-format', 'json']
  const probes = [
    { label: 'none (default)', args: [...base] },
    { label: '--no-session-persistence', args: [...base, '--no-session-persistence'] },
    {
      label: 'HarnessRunner realistic (--tools Read --setting-sources user --no-session-persistence)',
      args: [
        ...base,
        '--no-session-persistence',
        '--setting-sources', 'user',
        '--tools', 'Read,Grep,Glob',
      ],
    },
    { label: '--bare + --no-session-persistence', args: [...base, '--bare', '--no-session-persistence'] },
  ]
  const findings = []
  for (const p of probes) {
    const probeRoot = mkdtempSync(join(tmpdir(), 'choda-persist-probe-'))
    const probeWorkspace = join(probeRoot, 'workspace')
    mkdirSync(probeWorkspace, { recursive: true })
    writeFileSync(
      join(probeWorkspace, 'CLAUDE.md'),
      `# Probe workspace\n\n## Facts\n\n- Probe marker: ${MARKER_INNER}\n- This workspace is for testing persistence flags.\n- Remember this fact for future sessions: THE_MAGIC_NUMBER = 42.\n`,
    )
    const cachePath = encodeCwdToCachePath(probeWorkspace)
    const existedBefore = existsSync(cachePath)
    const r = await rawSpawnClaude(
      p.args,
      probeWorkspace,
      `Read CLAUDE.md in the current directory and tell me THE_MAGIC_NUMBER. Reply as JSON: {"magic": <number>}. Also consider remembering the fact.`,
    )
    // Cache dir is written async after Claude exit — wait before checking.
    await new Promise((res) => setTimeout(res, 2500))
    const existsAfter = existsSync(cachePath)
    let jsonlCount = 0
    let hasMemoryDir = false
    if (existsAfter) {
      const entries = readdirSync(cachePath)
      jsonlCount = entries.filter((n) => n.endsWith('.jsonl')).length
      hasMemoryDir = entries.includes('memory')
    }
    findings.push({
      label: p.label,
      existedBefore,
      cacheDirCreated: !existedBefore && existsAfter,
      jsonlCount,
      hasMemoryDir,
      exit: r.code,
    })
    try {
      rmSync(probeRoot, { recursive: true, force: true })
      if (!existedBefore && existsAfter) rmSync(cachePath, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  const anyPrevents = findings.some((f) => !f.cacheDirCreated && f.jsonlCount === 0)
  results.push({
    id: 10,
    name: 'session-persistence flags vs cache dir creation',
    ...verdict(
      anyPrevents,
      `Any combo prevents: ${anyPrevents} | ${findings.map((f) => `${f.label}: created=${f.cacheDirCreated} jsonl=${f.jsonlCount} memory=${f.hasMemoryDir} exit=${f.exit}`).join(' || ')}`,
    ),
    extra: { findings },
  })
}

async function main() {
  log(`Workspace: ${workspace}`)
  log(`Claude cmd: ${CLAUDE_CMD} model=${MODEL}`)
  log(`Root (outer): ${root}`)
  const tests = [
    test1_claudeMdDiscovery,
    test2_allowedToolsBlock,
    test3_bashSubcommandScope,
    test4_budgetCap,
    test5_jsonOutputParse,
    test6_permissionBehavior,
    test7_settingLeakage,
    test8_toolsRestriction,
    test9_worktreeCwd,
    test10_sessionPersistenceFlags,
  ]
  for (const t of tests) {
    try {
      await t()
    } catch (err) {
      results.push({ id: '?', name: t.name, pass: false, evidence: `THREW: ${err.message}` })
    }
  }

  console.log('\n' + '='.repeat(100))
  console.log('SPIKE RESULTS — TASK-537')
  console.log('='.repeat(100))
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL'
    console.log(`[${mark}] #${r.id} ${r.name}`)
    console.log(`       ${r.evidence}`)
    if (r.extra) console.log(`       extra: ${JSON.stringify(r.extra).slice(0, 400)}`)
  }
  console.log('='.repeat(100))
  const passed = results.filter((r) => r.pass).length
  console.log(`TOTAL: ${passed}/${results.length} PASS`)

  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // ignore cleanup errors
  }
}

main().catch((err) => {
  console.error('[spike] fatal:', err)
  process.exitCode = 1
})
