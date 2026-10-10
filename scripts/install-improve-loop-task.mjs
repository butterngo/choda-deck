// TASK-2361 — install/uninstall the \ChodaImproveLoop scheduled task: daily at
// 08:45 (before ChodaActivityDigest at 09:00) it runs `claude -p "/improve-loop
// <ws>"` (TASK-2358) for every workspace whose .choda/improve.json says
// `mode: "scheduled"`, one after another.
//
// Installed once. Which workspaces run is decided at RUN time, by `--run`: the
// launcher reads the workspaces table and each config every morning, so turning
// a workspace on or off is only ever an edit to its `mode` (the companion's
// Improve tab does it). Model calls happen only for those opted-in workspaces —
// adr-when-this-project-may-call-a-model, amendment of 2026-10-10.
//
// Modelled on install-activity-digest-task.mjs and the same gotcha
// "windows-task-scheduler-as-a-service-host-three-traps": the VBS wrapper waits
// (trap 2), a worktree needs --data-dir (trap 4), claude.cmd is resolved to a
// stable path outside fnm_multishells, and removal is verified by query.
//
// Usage:
//   node scripts/install-improve-loop-task.mjs            # install/replace
//   node scripts/install-improve-loop-task.mjs --uninstall
//   node scripts/install-improve-loop-task.mjs --run --claude <path>   # what the task runs
//   Options: --data-dir <path> --claude <path to claude.cmd>

import * as fs from 'fs'
import * as path from 'path'
import { createRequire } from 'module'
import { execFileSync, spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { isEphemeralPath, resolveClaude } from './install-activity-digest-task.mjs'

export { isEphemeralPath, resolveClaude }

export const TASK_NAME = 'ChodaImproveLoop'
export const DAILY_AT = '08:45'

// Mirrors the skill's allowed-tools and the companion's RUN_ALLOWED_TOOLS. A
// `claude -p` that hits a permission prompt has nobody to answer it.
export const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Glob',
  'Task',
  'mcp__choda-tasks__inbox_add',
  'mcp__choda-tasks__inbox_list'
]

// Workspace ids and model names reach a cmd.exe command line; nothing else may.
const SAFE = /^[A-Za-z0-9._-]+$/

/** The config of one workspace, or null when it has none or it does not parse. */
export function readImproveConfig(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.choda', 'improve.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * The workspaces to run, in the order given: unarchived, with a config whose
 * `mode` is exactly "scheduled". `manual`, `off`, no config and an unreadable
 * config are all skipped — opting in is explicit or it did not happen.
 */
export function pickScheduled(workspaces, readConfig = readImproveConfig) {
  const picked = []
  for (const ws of workspaces) {
    if (ws.archivedAt || !SAFE.test(ws.id)) continue
    const config = readConfig(ws.cwd)
    if (config?.mode !== 'scheduled') continue
    const model =
      typeof config.model === 'string' && SAFE.test(config.model) ? config.model : 'sonnet'
    picked.push({ id: ws.id, model })
  }
  return picked
}

export function claudeArgs(ws, model) {
  return ['-p', `/improve-loop ${ws}`, '--model', model, '--allowedTools', ALLOWED_TOOLS.join(' ')]
}

/** Run each picked workspace in turn; one failing does not stop the next. */
export function runScheduled(
  workspaces,
  { readConfig = readImproveConfig, invoke, log = console.log }
) {
  const picked = pickScheduled(workspaces, readConfig)
  log(
    `[improve-loop] ${picked.length} scheduled: ${picked.map((p) => p.id).join(', ') || '(none)'}`
  )
  const results = []
  for (const { id, model } of picked) {
    const code = invoke(id, model)
    log(`[improve-loop] ${id} exit ${code}`)
    results.push({ id, code })
  }
  return results
}

export function buildLauncher({ nodeExe, script, claudeCmd, dataDir, repoRoot, logFile }) {
  return [
    '@echo off',
    `set "CHODA_DATA_DIR=${dataDir}"`,
    // claude.cmd's npm shim looks for node beside itself first; PATH is the fallback.
    `set "PATH=${path.dirname(claudeCmd)};%PATH%"`,
    `cd /d "${repoRoot}"`,
    `echo [improve-loop] start %DATE% %TIME% >> "${logFile}"`,
    `"${nodeExe}" "${script}" --run --claude "${claudeCmd}" >> "${logFile}" 2>&1`,
    `echo [improve-loop] exit %ERRORLEVEL% %DATE% %TIME% >> "${logFile}"`,
    ''
  ].join('\r\n')
}

export function buildVbs(launcherCmd) {
  // Window style 0 = hidden; True = wait, so the task state follows the run (trap 2).
  return `WScript.Quit CreateObject("Wscript.Shell").Run("""${launcherCmd}""", 0, True)\r\n`
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : undefined
}

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

function listWorkspaces(repoRoot, dataDir) {
  const Database = createRequire(path.join(repoRoot, 'package.json'))('better-sqlite3')
  const db = new Database(path.join(dataDir, 'database', 'choda-deck.db'), {
    readonly: true,
    fileMustExist: true
  })
  try {
    return db.prepare('SELECT id, cwd, archived_at AS archivedAt FROM workspaces ORDER BY id').all()
  } finally {
    db.close()
  }
}

function run(repoRoot, dataDir) {
  const claudeCmd = arg('--claude')
  if (!claudeCmd) throw new Error('--run needs --claude <path to claude.cmd>')
  runScheduled(listWorkspaces(repoRoot, dataDir), {
    invoke: (ws, model) => {
      // A .cmd shim only launches through cmd.exe. Every token is either a
      // constant or matched SAFE, so the hand-built line carries no quote or
      // metacharacter from the outside.
      const line = [`"${claudeCmd}"`, ...claudeArgs(ws, model).map((a) => `"${a}"`)].join(' ')
      const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
        cwd: repoRoot,
        stdio: 'inherit',
        windowsVerbatimArguments: true,
        timeout: 25 * 60 * 1000
      })
      return r.status ?? -1
    }
  })
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const explicitDataDir = arg('--data-dir')

  // The scheduled run. Its data dir was fixed at install time and arrives as
  // CHODA_DATA_DIR from the launcher. The worktree check below must not run
  // here: under Task Scheduler `git` is not on PATH (found on the first live run).
  if (process.argv.includes('--run')) {
    return run(
      repoRoot,
      path.resolve(explicitDataDir ?? process.env.CHODA_DATA_DIR ?? path.join(repoRoot, 'data'))
    )
  }

  // Trap 4 — in a worktree, repoRoot/data is not the real data dir.
  let gitDir, commonDir
  try {
    gitDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-dir']))
    commonDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']))
  } catch {
    if (!explicitDataDir) {
      console.error(
        '[improve-loop] git is not on PATH, so a worktree cannot be ruled out. Run from a shell with git, or pass --data-dir <path>.'
      )
      process.exit(1)
    }
  }
  if (gitDir !== commonDir && !explicitDataDir) {
    console.error(
      `[improve-loop] refusing to run from the git worktree ${repoRoot}: its data dir is not the real one. ` +
        'Run from the main checkout, or pass --data-dir <path>.'
    )
    process.exit(1)
  }

  const dataDir = path.resolve(explicitDataDir ?? path.join(repoRoot, 'data'))

  const logDir = path.join(dataDir, 'logs')
  const logFile = path.join(logDir, 'improve-loop.log')
  const launcherCmd = path.join(dataDir, 'improve-loop-launcher.cmd')
  const hiddenVbs = path.join(dataDir, 'improve-loop-hidden.vbs')

  if (process.argv.includes('--uninstall')) {
    try {
      ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`)
    } catch {
      /* not running */
    }
    try {
      ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop`)
      console.log(`[improve-loop] removed scheduled task ${TASK_NAME}`)
    } catch {
      console.log(`[improve-loop] task ${TASK_NAME} was not registered`)
    }
    for (const f of [launcherCmd, hiddenVbs]) if (fs.existsSync(f)) fs.rmSync(f)
    console.log(
      `[improve-loop] verify: schtasks /Query /TN ${TASK_NAME} should report it does not exist`
    )
    return
  }

  const claudeCmd = resolveClaude(arg('--claude'), () => {
    try {
      return ps('(Get-Command claude.cmd -ErrorAction Stop).Source').trim()
    } catch {
      return undefined
    }
  })
  // node.exe sits beside claude.cmd in the fnm installation dir; process.execPath
  // may be the ephemeral multishell one.
  const besideClaude = path.join(path.dirname(claudeCmd), 'node.exe')
  const nodeExe = fs.existsSync(besideClaude) ? besideClaude : fs.realpathSync(process.execPath)
  if (isEphemeralPath(nodeExe))
    throw new Error(`refusing node at ${nodeExe}: under fnm_multishells`)

  fs.mkdirSync(logDir, { recursive: true })
  const script = fileURLToPath(import.meta.url)
  fs.writeFileSync(
    launcherCmd,
    buildLauncher({ nodeExe, script, claudeCmd, dataDir, repoRoot, logFile })
  )
  fs.writeFileSync(hiddenVbs, buildVbs(launcherCmd))

  // Daily only, no logon trigger: a missed 08:45 runs at the next chance
  // (StartWhenAvailable) rather than on every sign-in.
  ps(
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${hiddenVbs}"';` +
      `$trigger = New-ScheduledTaskTrigger -Daily -At '${DAILY_AT}';` +
      `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2);` +
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`
  )
  console.log(`[improve-loop] scheduled task: ${TASK_NAME} (daily ${DAILY_AT}, hidden)`)
  console.log(`[improve-loop] claude:        ${claudeCmd}`)
  console.log(`[improve-loop] launcher:      ${launcherCmd}`)
  console.log(`[improve-loop] log file:      ${logFile}`)
  console.log(`[improve-loop] run now:       schtasks /run /tn \\${TASK_NAME}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
