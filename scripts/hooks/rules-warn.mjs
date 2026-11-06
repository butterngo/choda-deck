/**
 * TASK-3130 — Claude Code `SessionStart` hook: warn, never block, when a session
 * opens in a project that breaks rule 1 or 2 of personal-operating-rules (not one
 * of the week's picked projects; a green PR or a task waiting for Butter's check).
 * Most active time is hand work that never meets the /choda-autopilot §2.3 gate,
 * so the reminder lives where every session starts.
 *
 * ## Install
 *
 * In `~/.claude/settings.json` under `hooks.SessionStart`:
 *
 * ```jsonc
 * { "hooks": [{ "type": "command",
 *     "command": "C:\\...\\node.exe",
 *     "args": ["C:\\dev\\choda-deck\\scripts\\hooks\\rules-warn.mjs",
 *              "--data-dir", "C:\\dev\\choda-deck\\data"] }] }
 * ```
 *
 * ## Contract
 *
 * stdin: `{ cwd, hook_event_name, session_id, ... }`. Runs
 * `choda-deck rules check --cwd <cwd> --json`. When the verdict is `blocked`, prints
 * `{ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }`
 * listing each reason; otherwise prints nothing. Always exits 0 — a broken CLI,
 * a missing DB or bad input must never stop a session.
 *
 * Flags: `--data-dir <dir>` (sets CHODA_DATA_DIR), `--cli <path>` (default
 * `<repo>/dist/cli.cjs`, overridable for tests).
 */

import { spawnSync } from 'child_process'
import * as path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))

export function parseFlags(argv) {
  const out = { cli: path.join(here, '..', '..', 'dist', 'cli.cjs'), dataDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cli') out.cli = argv[++i]
    else if (argv[i] === '--data-dir') out.dataDir = argv[++i]
  }
  return out
}

/** The hook's stdout for a rules-check verdict, or '' when there is nothing to say. */
export function hookOutput(verdict) {
  if (!verdict || verdict.verdict !== 'blocked' || !Array.isArray(verdict.reasons)) return ''
  const lines = verdict.reasons.map((r) => `- ${r.message}`)
  const additionalContext = [
    `Personal operating rules (${verdict.projectId}, ${verdict.week}) — this project breaks:`,
    ...lines,
    'Warn Butter before starting new work here; he decides whether to continue.'
  ].join('\n')
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext }
  })
}

export function runCheck(cwd, flags) {
  const env = { ...process.env }
  if (flags.dataDir) env.CHODA_DATA_DIR = flags.dataDir
  const res = spawnSync(process.execPath, [flags.cli, 'rules', 'check', '--cwd', cwd, '--json'], {
    encoding: 'utf8',
    env,
    timeout: 20_000
  })
  if (res.error || (res.status !== 0 && res.status !== 3)) return null
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

async function readStdin() {
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

async function main() {
  try {
    const input = JSON.parse((await readStdin()) || '{}')
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd()
    const out = hookOutput(runCheck(cwd, parseFlags(process.argv.slice(2))))
    if (out) process.stdout.write(out + '\n')
  } catch {
    // Never block a session.
  }
  process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main()
}
