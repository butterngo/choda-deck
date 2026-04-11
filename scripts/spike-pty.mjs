// Stage 1 smoke test: isolated node-pty spawn of `claude` in a target cwd.
// Purpose: validate that node-pty + ConPTY + claude.cmd interop works at the
// plain-Node level before committing to the Electron + xterm.js wiring.
//
// Runs for 6 seconds, captures stdout, writes a Ctrl+C to exit, prints results.
// Pass criterion: claude's startup banner appears in the captured output.
//
// Usage: node scripts/spike-pty.mjs

import pty from 'node-pty'

const TARGET_CWD = 'C:\\dev\\test\\workflow-engine'
const SHELL_CMD = 'claude.cmd'
const DURATION_MS = 6000

console.log(`[spike] spawning ${SHELL_CMD} in ${TARGET_CWD}`)

let buffer = ''
let exitCode = null
let exited = false

const ptyProcess = pty.spawn(SHELL_CMD, [], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: TARGET_CWD,
  env: process.env
})

ptyProcess.onData((data) => {
  buffer += data
  process.stdout.write(data)
})

ptyProcess.onExit(({ exitCode: code }) => {
  exitCode = code
  exited = true
})

// After DURATION_MS, send Ctrl+C twice to exit claude, then kill if still alive.
setTimeout(() => {
  if (!exited) {
    console.log('\n[spike] sending Ctrl+C')
    ptyProcess.write('\x03')
  }
}, DURATION_MS)

setTimeout(() => {
  if (!exited) {
    console.log('\n[spike] sending Ctrl+C again')
    ptyProcess.write('\x03')
  }
}, DURATION_MS + 500)

setTimeout(() => {
  if (!exited) {
    console.log('\n[spike] force-killing pty')
    try {
      ptyProcess.kill()
    } catch (e) {
      console.log('[spike] kill error', e)
    }
  }

  const passed =
    buffer.length > 0 &&
    (buffer.toLowerCase().includes('claude') ||
      buffer.includes('Welcome') ||
      buffer.includes('>'))

  console.log('\n========== SPIKE RESULT ==========')
  console.log(`bytes captured: ${buffer.length}`)
  console.log(`exited cleanly: ${exited}`)
  console.log(`exit code: ${exitCode}`)
  console.log(`pass criterion (output contains claude/Welcome/prompt): ${passed}`)
  console.log('===================================')

  process.exit(passed ? 0 : 1)
}, DURATION_MS + 1500)
