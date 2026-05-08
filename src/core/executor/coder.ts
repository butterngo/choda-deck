import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Task } from '../domain/task-types'
import {
  CoderDriverError,
  type CoderDriver,
  type CoderRunInput,
  type CoderRunOutput
} from './coder-driver'

export const CODER_SYSTEM_PROMPT = `You are the Coder stage of a Playwright FE test executor.

Your only job: write ONE Playwright spec file under e2e/tests/<feature>.spec.ts implementing the task's Acceptance Criteria. Do not modify any other file. Do not edit production source. Do not run tests. The cwd you are spawned in is the remote-workflow repo root, so paths are relative to that root.

Hard rules (zero exceptions):
1. Selectors: use only data-testid (page.getByTestId), getByRole, getByLabel. Forbidden: text=, raw CSS, XPath.
2. Waits: use waitForSelector or expect().toBeVisible(). Forbidden: page.waitForTimeout(N) for state. A documented animation timeout is the only allowed exception (// justify: animation).
3. Assertions: every check must be expect()-verifiable. No "AI judges UI" prose-only checks.
4. File naming: <feature>.spec.ts under e2e/tests/ — kebab-case, single file per task. The remote-workflow repo's playwright.config.ts has testDir: './e2e/tests', so specs MUST land there to be picked up.
5. Mocks: declared in colocated mocks/ directory, imported explicitly. No inline route.fulfill with hardcoded green payloads unless an AC says "mock X returning Y".
6. Forbidden in spec: test.only, test.skip (any manual skip), --update-snapshots, expect.soft without "// justify:" comment, retries set on the spec.
7. No spec-level retries: test.describe.configure({ retries: N }) with N>0 is forbidden.

Test title contract:
- Every test('...') title MUST start with the AC id it covers, e.g. test('AC-1 login redirects to home', ...). The Tester maps results back to AC ids by parsing this prefix.
- One test per AC id is the default. If a single AC needs multiple test cases, use the same AC-N prefix for each — all must pass for the AC to be marked pass.

Process:
- Read the task body (passed in user prompt) — focus on ## Acceptance and any selector/flow contract.
- Use Glob/Grep/Read to inspect e2e/tests patterns, e2e/pages Page Objects, and existing data-testid coverage. Reuse Page Objects when present rather than re-declaring selectors.
- Write the spec via the Write tool.
- Stop after the file is written. Do NOT run pnpm, do NOT commit, do NOT echo the file content as your final answer.

Return a single JSON object as your final assistant message:
{ "filePath": "<repo-relative path of the spec written>" }`

export class ClaudePCoderDriver implements CoderDriver {
  readonly id = 'claude-p'

  constructor(
    private readonly options: {
      claudeBin?: string
      model?: string
      timeoutMs?: number
    } = {}
  ) {}

  async spawnCoder(input: CoderRunInput): Promise<CoderRunOutput> {
    const start = Date.now()
    const userPrompt = buildUserPrompt(input.task)
    const claudeBin = this.options.claudeBin ?? 'claude'
    const model = this.options.model ?? 'claude-haiku-4-5-20251001'
    const timeoutMs = this.options.timeoutMs ?? 5 * 60 * 1000

    const args = [
      '-p',
      userPrompt,
      '--output-format',
      'json',
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
      '--append-system-prompt',
      input.systemPrompt,
      '--max-budget-usd',
      input.maxBudgetUsd.toFixed(2)
    ]

    const headBefore = await captureHead(input.worktreeCwd)

    const result = await runProcess(claudeBin, args, {
      cwd: input.worktreeCwd,
      timeoutMs
    })

    if (result.exitCode !== 0) {
      throw new CoderDriverError(
        'spawn',
        `claude -p exited ${result.exitCode}`,
        result.stderr.slice(0, 4000)
      )
    }

    const parsed = parseClaudeJson(result.stdout)
    const filePath = await locateNewSpec(input.worktreeCwd, parsed.filePath)
    if (!filePath) {
      throw new CoderDriverError(
        'parse',
        `Coder did not write a *.spec.ts under remote-workflow/e2e/ (parsed=${parsed.filePath ?? '<none>'})`
      )
    }

    const commitSha = await commitSpec(input.worktreeCwd, filePath, input.task.id, headBefore)

    return {
      filePath,
      commitSha,
      durationMs: Date.now() - start,
      costUsd: parsed.totalCostUsd,
      numTurns: parsed.numTurns
    }
  }
}

interface ParsedClaudeOutput {
  filePath: string | null
  totalCostUsd: number | null
  numTurns: number | null
}

function parseClaudeJson(stdout: string): ParsedClaudeOutput {
  let root: unknown
  try {
    root = JSON.parse(stdout)
  } catch {
    throw new CoderDriverError('parse', 'claude -p stdout is not valid JSON', stdout.slice(0, 2000))
  }
  if (!isRecord(root)) {
    throw new CoderDriverError('parse', 'claude -p root is not an object')
  }
  if (root.is_error === true) {
    throw new CoderDriverError(
      'parse',
      `claude -p reported is_error: ${typeof root.result === 'string' ? root.result : 'unknown'}`
    )
  }
  const totalCostUsd = typeof root.total_cost_usd === 'number' ? root.total_cost_usd : null
  const numTurns = typeof root.num_turns === 'number' ? root.num_turns : null
  const result = typeof root.result === 'string' ? root.result : ''
  const filePath = extractFilePath(result)
  return { filePath, totalCostUsd, numTurns }
}

function extractFilePath(result: string): string | null {
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(result)
  const candidates = [fenceMatch?.[1] ?? '', result]
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c.trim())
      if (isRecord(obj) && typeof obj.filePath === 'string') return obj.filePath
    } catch {
      // try next
    }
  }
  const inline = /"filePath"\s*:\s*"([^"]+)"/.exec(result)
  return inline ? inline[1] : null
}

async function locateNewSpec(cwd: string, hinted: string | null): Promise<string | null> {
  if (hinted) {
    const abs = path.isAbsolute(hinted) ? hinted : path.join(cwd, hinted)
    if (fs.existsSync(abs) && abs.endsWith('.spec.ts')) {
      return path.relative(cwd, abs).replace(/\\/g, '/')
    }
  }
  const status = await runProcess('git', ['status', '--porcelain'], { cwd, timeoutMs: 30_000 })
  if (status.exitCode !== 0) return null
  const newFiles = status.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('?? ') || l.startsWith('A '))
    .map((l) => l.replace(/^(\?\?|A)\s+/, ''))
    .filter((p) => p.endsWith('.spec.ts') && p.includes('e2e/tests/'))
  return newFiles[0] ?? null
}

async function captureHead(cwd: string): Promise<string> {
  const r = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 })
  return r.stdout.trim()
}

async function commitSpec(
  cwd: string,
  specRelPath: string,
  taskId: string,
  headBefore: string
): Promise<string> {
  const add = await runProcess('git', ['add', '--', specRelPath], { cwd, timeoutMs: 30_000 })
  if (add.exitCode !== 0) {
    throw new CoderDriverError('commit', `git add failed: ${add.stderr.slice(0, 1000)}`)
  }
  const message = `test(${taskId}): coder-generated playwright spec\n\nGenerated by ClaudePCoderDriver from task ${taskId} body.\nFile: ${specRelPath}`
  const commit = await runProcess(
    'git',
    ['commit', '-m', message, '--no-verify'],
    { cwd, timeoutMs: 60_000 }
  )
  if (commit.exitCode !== 0) {
    throw new CoderDriverError('commit', `git commit failed: ${commit.stderr.slice(0, 1000)}`)
  }
  const rev = await runProcess('git', ['rev-parse', 'HEAD'], { cwd, timeoutMs: 30_000 })
  const sha = rev.stdout.trim()
  if (sha === headBefore) {
    throw new CoderDriverError('commit', 'HEAD did not advance after commit')
  }
  return sha
}

function buildUserPrompt(task: Task): string {
  return [
    `# Task ${task.id}: ${task.title}`,
    '',
    'Read the body below carefully. Implement ONE Playwright spec under remote-workflow/e2e/ that covers the ## Acceptance criteria. Follow the hard rules in your system prompt.',
    '',
    '---',
    task.body ?? '(no body)'
  ].join('\n')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface ProcResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface RunOptions {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
}

export function runProcess(cmd: string, args: string[], opts: RunOptions): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: process.platform === 'win32',
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`process timed out after ${opts.timeoutMs}ms: ${cmd} ${args.join(' ')}`))
        return
      }
      resolve({ exitCode: code ?? -1, stdout, stderr })
    })
  })
}

export async function verifySpecSyntax(
  cwd: string,
  specRelPath: string,
  pnpmBin: string = 'pnpm'
): Promise<{ ok: boolean; output: string }> {
  const r = await runProcess(pnpmBin, ['playwright', 'test', '--list', specRelPath], {
    cwd,
    timeoutMs: 90_000
  })
  return { ok: r.exitCode === 0, output: `${r.stdout}\n${r.stderr}` }
}
