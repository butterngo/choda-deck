/**
 * TASK-2383 — Claude Code hook: tell Butter when a long turn finishes or a
 * session waits on him, and record which sessions are waiting (TASK-2384 shows
 * them on the companion's decide screen).
 *
 * From archived digest idea INBOX-2118: waiting on Claude peaked at 74% of
 * active time on low-parallelism days, and finished turns were found by polling
 * terminals.
 *
 * Events (stdin JSON: { hook_event_name, session_id, cwd, message? }):
 *   UserPromptSubmit  remember when the turn started; clear this session's
 *                     attention file (Butter is here now)
 *   Stop              write state "finished"; toast only if the turn ran
 *                     >= 120 s (short turns are watched anyway)
 *   Notification      write state "waiting" and toast — Claude needs a
 *                     permission or an answer
 *
 * Attention file: <data-dir>/attention/<session_id>.json
 *   { sessionId, cwd, state: "finished" | "waiting", since }   (ISO time)
 *
 * Installed by scripts/install-attention-hooks.mjs, which passes --data-dir
 * (hooks do not inherit CHODA_DATA_DIR). Safety: never blocks or fails the
 * host — every path exits 0, and the toast is a detached child.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LONG_TURN_MS = 120_000

/** Pure: what one event means. */
export function decide(event, { startedAt, now }) {
  const name = event.hook_event_name
  if (name === 'UserPromptSubmit') return { start: true, clear: true, notify: null, state: null }
  if (name === 'Notification') {
    return {
      start: false,
      clear: false,
      state: 'waiting',
      notify: { kind: 'waiting', detail: String(event.message ?? 'Claude đang chờ anh') }
    }
  }
  if (name === 'Stop') {
    const ms = startedAt === null ? 0 : now - startedAt
    return {
      start: false,
      clear: false,
      state: 'finished',
      notify: ms >= LONG_TURN_MS ? { kind: 'finished', minutes: Math.round(ms / 60_000) } : null
    }
  }
  return { start: false, clear: false, state: null, notify: null }
}

export function toastText(notify, cwd) {
  const where = path.basename(cwd || '') || 'Claude'
  if (notify.kind === 'waiting')
    return { title: `Claude đang chờ anh — ${where}`, body: notify.detail }
  return {
    title: `Claude xong việc — ${where}`,
    body: `Lượt chạy ${notify.minutes} phút đã kết thúc.`
  }
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/

/** Apply one event to the attention dir. Returns the decision (for tests). */
export function handleEvent(event, { dataDir, now = Date.now(), toast = showToast }) {
  const sid = String(event.session_id ?? '')
  if (!SAFE_ID.test(sid)) return null
  const dir = path.join(dataDir, 'attention')
  const turns = path.join(dir, '.turns')
  const stateFile = path.join(dir, `${sid}.json`)
  const startFile = path.join(turns, sid)
  let startedAt = null
  try {
    startedAt = Number(fs.readFileSync(startFile, 'utf8')) || null
  } catch {
    // no turn recorded
  }
  const d = decide(event, { startedAt, now })
  fs.mkdirSync(turns, { recursive: true })
  if (d.start) fs.writeFileSync(startFile, String(now))
  if (d.clear) fs.rmSync(stateFile, { force: true })
  if (d.state) {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        sessionId: sid,
        cwd: event.cwd ?? '',
        state: d.state,
        since: new Date(now).toISOString()
      })
    )
  }
  if (d.notify) toast(toastText(d.notify, event.cwd))
  return d
}

/** Windows balloon via PowerShell, detached so the hook returns at once. */
export function showToast({ title, body }) {
  if (process.platform !== 'win32') return
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$n = New-Object System.Windows.Forms.NotifyIcon;',
    '$n.Icon = [System.Drawing.SystemIcons]::Information;',
    '$n.Visible = $true;',
    '$n.ShowBalloonTip(10000, $env:CHODA_TOAST_TITLE, $env:CHODA_TOAST_BODY, "Info");',
    'Start-Sleep -Seconds 11; $n.Dispose()'
  ].join(' ')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    // Text travels in the environment, never on the command line: no quoting.
    env: { ...process.env, CHODA_TOAST_TITLE: title, CHODA_TOAST_BODY: body.slice(0, 250) }
  })
  child.unref()
}

function dataDirArg() {
  const i = process.argv.indexOf('--data-dir')
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1]
  return process.env.CHODA_DATA_DIR || null
}

async function main() {
  try {
    const dataDir = dataDirArg()
    if (!dataDir) return
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (!text) return
    handleEvent(JSON.parse(text), { dataDir })
  } catch (err) {
    process.stderr.write(`[attention-hook] ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().finally(() => process.exit(0))
}
