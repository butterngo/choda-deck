// TASK-2155 — install/uninstall the \ChodaActivityDigest scheduled task: at
// logon and daily at 09:00 it runs `claude -p "/daily-digest"` (TASK-2154), which
// catches up the activity digests (TASK-2151) and posts the summaries.
//
// Modelled on install-companion-service.mjs, minus what a ONE-SHOT job does not
// need: no restart loop (trap 1) and no port kill (trap 3). What does apply, per
// the gotcha "windows-task-scheduler-as-a-service-host-three-traps":
//   - the VBS wrapper WAITS (trap 2), so the task state tracks the run
//   - refuse to run from a git worktree without --data-dir (trap 4): dataDir is
//     derived from repoRoot and a worktree would point at the wrong data
//   - removal is verified by query, never by exit code
//
// Usage:
//   node scripts/install-activity-digest-task.mjs            # install/replace
//   node scripts/install-activity-digest-task.mjs --uninstall
//   Options: --data-dir <path> --claude <path to claude.cmd>

import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

export const TASK_NAME = 'ChodaActivityDigest'
export const DAILY_AT = '09:00'

// Pre-approved for the unattended run, mirroring the skill's allowed-tools. A
// `claude -p` that hits a permission prompt has nobody to answer it.
export const ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Glob',
  'mcp__choda-tasks__conversation_list',
  'mcp__choda-tasks__conversation_open',
  'mcp__choda-tasks__conversation_read',
  'mcp__choda-tasks__conversation_add',
  'mcp__choda-tasks__inbox_add'
]

/** The fnm multishell dir is per-shell and vanishes; a scheduled task must never point into it. */
export function isEphemeralPath(p) {
  return /fnm_multishells/i.test(p)
}

/** Resolve claude.cmd to a stable absolute path, following fnm's multishell symlink. */
export function resolveClaude(explicit, lookup) {
  const found = explicit ?? lookup()
  if (!found) throw new Error('claude.cmd not found on PATH — pass --claude <path>')
  const real = fs.realpathSync(found)
  if (isEphemeralPath(real)) {
    throw new Error(
      `refusing ${real}: it lives under fnm_multishells and will not exist at logon — pass --claude <stable path>`
    )
  }
  return real
}

export function buildLauncher({ claudeCmd, dataDir, repoRoot, logFile }) {
  const nodeDir = path.dirname(claudeCmd)
  return [
    '@echo off',
    `set "CHODA_DATA_DIR=${dataDir}"`,
    // claude.cmd's npm shim looks for node beside itself first; PATH is the fallback.
    `set "PATH=${nodeDir};%PATH%"`,
    `cd /d "${repoRoot}"`,
    `echo [activity-digest] start %DATE% %TIME% >> "${logFile}"`,
    `call "${claudeCmd}" -p "/daily-digest" --allowedTools "${ALLOWED_TOOLS.join(' ')}" >> "${logFile}" 2>&1`,
    `echo [activity-digest] exit %ERRORLEVEL% %DATE% %TIME% >> "${logFile}"`,
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

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const explicitDataDir = arg('--data-dir')

  // Trap 4 — in a worktree, repoRoot/data is not the real data dir.
  const gitDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-dir']))
  const commonDir = path.resolve(repoRoot, git(repoRoot, ['rev-parse', '--git-common-dir']))
  if (gitDir !== commonDir && !explicitDataDir) {
    console.error(
      `[activity-digest] refusing to run from the git worktree ${repoRoot}: its data dir is not the real one. ` +
        'Run from the main checkout, or pass --data-dir <path>.'
    )
    process.exit(1)
  }

  const dataDir = path.resolve(explicitDataDir ?? path.join(repoRoot, 'data'))
  const logDir = path.join(dataDir, 'logs')
  const logFile = path.join(logDir, 'activity-digest.log')
  const launcherCmd = path.join(dataDir, 'activity-digest-launcher.cmd')
  const hiddenVbs = path.join(dataDir, 'activity-digest-hidden.vbs')

  if (process.argv.includes('--uninstall')) {
    try {
      ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`)
    } catch {
      /* not running */
    }
    try {
      ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop`)
      console.log(`[activity-digest] removed scheduled task ${TASK_NAME}`)
    } catch {
      console.log(`[activity-digest] task ${TASK_NAME} was not registered`)
    }
    for (const f of [launcherCmd, hiddenVbs]) if (fs.existsSync(f)) fs.rmSync(f)
    console.log(
      '[activity-digest] verify: Get-ScheduledTask -TaskName ChodaActivityDigest should return nothing'
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

  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(launcherCmd, buildLauncher({ claudeCmd, dataDir, repoRoot, logFile }))
  fs.writeFileSync(hiddenVbs, buildVbs(launcherCmd))

  ps(
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${hiddenVbs}"';` +
      `$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -Daily -At '${DAILY_AT}'));` +
      `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30);` +
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null`
  )
  console.log(
    `[activity-digest] scheduled task: ${TASK_NAME} (at logon + daily ${DAILY_AT}, hidden)`
  )
  console.log(`[activity-digest] claude:        ${claudeCmd}`)
  console.log(`[activity-digest] launcher:      ${launcherCmd}`)
  console.log(`[activity-digest] log file:      ${logFile}`)
  console.log(`[activity-digest] run now:       schtasks /run /tn \\${TASK_NAME}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
