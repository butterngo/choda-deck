// TASK-1375 — install/uninstall the companion API as an auto-start Windows
// background service via Task Scheduler. Pure Node + built-in schtasks/PowerShell;
// no NSSM, no Electron. The task runs a generated launcher .cmd (env + log
// redirect) through a VBS wrapper so no console window appears at logon.
//
// Usage:
//   node scripts/install-companion-service.mjs            # install/replace + start
//   node scripts/install-companion-service.mjs --uninstall
//   Options: --data-dir <path> --content-root <path> --port <n>

import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const TASK_NAME = 'ChodaCompanionServer'
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverBundle = path.join(repoRoot, 'dist', 'companion-server.cjs')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const dataDir = path.resolve(arg('--data-dir', path.join(repoRoot, 'data')))
const contentRoot = arg('--content-root', process.env.CHODA_CONTENT_ROOT ?? '')
const port = arg('--port', '7338')
const logDir = path.join(dataDir, 'logs')
const logFile = path.join(logDir, 'companion-server.log')
const launcherCmd = path.join(dataDir, 'companion-service-launcher.cmd')
const hiddenVbs = path.join(dataDir, 'companion-service-hidden.vbs')

function ps(script) {
  // stderr piped (not inherited) so expected not-found errors in try/catch paths
  // don't spray the console.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

// Stop the running task (kills the launcher loop + node) — needed before both
// uninstall and reinstall so the old instance releases the port.
function stopTask() {
  try {
    ps(`Stop-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction Stop`)
  } catch {
    /* not running / not registered */
  }
  // Ending the task kills wscript+cmd but the node grandchild survives (verified
  // live) — kill whatever still owns the port. Port-scoped, never name-scoped.
  try {
    ps(
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1;` +
        `if ($c) { Stop-Process -Id $c.OwningProcess -Force }`
    )
  } catch {
    /* nothing listening */
  }
}

function uninstall() {
  stopTask()
  try {
    ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction Stop`)
    console.log(`[install] removed scheduled task ${TASK_NAME}`)
  } catch {
    console.log(`[install] task ${TASK_NAME} was not registered`)
  }
  for (const f of [launcherCmd, hiddenVbs]) {
    if (fs.existsSync(f)) fs.rmSync(f)
  }
}

function install() {
  if (!fs.existsSync(serverBundle)) {
    console.error(`[install] missing ${serverBundle} — run "pnpm run build:companion" first`)
    process.exit(1)
  }
  fs.mkdirSync(logDir, { recursive: true })
  stopTask()

  // Launcher: env + append-mode log redirect. Node's own console.error goes to
  // stderr, so 2>&1 captures startup lines like "[companion] listening on ...".
  const envLines = [
    `set "CHODA_DATA_DIR=${dataDir}"`,
    contentRoot ? `set "CHODA_CONTENT_ROOT=${contentRoot}"` : '',
    `set "CHODA_COMPANION_PORT=${port}"`
  ].filter(Boolean)
  // The launcher is the supervisor: Task Scheduler's restart-on-failure does not
  // reliably fire for an action that ran-then-exited (verified live, TASK-1375),
  // so the .cmd loops — node crash → 15s backoff → relaunch. Uninstall stops the
  // loop by ending the task (kills the cmd tree).
  fs.writeFileSync(
    launcherCmd,
    [
      '@echo off',
      ...envLines,
      ':loop',
      `node "${serverBundle}" >> "${logFile}" 2>&1`,
      `echo [launcher] server exited %ERRORLEVEL% — restarting in 15s >> "${logFile}"`,
      'timeout /t 15 /nobreak > nul',
      'goto loop',
      ''
    ].join('\r\n')
  )

  // VBS wrapper: window style 0 = fully hidden (cmd via schtasks always flashes
  // a console otherwise). Wait (True) + propagate the exit code — otherwise the
  // task "succeeds" the moment node spawns and restart-on-failure never fires.
  fs.writeFileSync(
    hiddenVbs,
    `WScript.Quit CreateObject("Wscript.Shell").Run("""${launcherCmd}""", 0, True)\r\n`
  )

  // Register-ScheduledTask instead of bare schtasks /create: only the PS module
  // exposes restart-on-failure settings (AC-4).
  ps(
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${hiddenVbs}"';` +
      `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME;` +
      `$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable;` +
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`
  )
  ps(`Start-ScheduledTask -TaskName '${TASK_NAME}'`)
  console.log(`[install] scheduled task: ${TASK_NAME} (logon trigger, hidden, restart x3)`)
  console.log(`[install] log file:       ${logFile}`)
  console.log(`[install] health check:   curl http://127.0.0.1:${port}/healthz`)
}

if (process.argv.includes('--uninstall')) uninstall()
else install()
