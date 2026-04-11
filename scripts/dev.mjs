#!/usr/bin/env node
// Dev/preview wrapper for electron-vite.
//
// Why this exists: when `npm run dev` is launched from within a Claude Code
// CLI session (or any parent process that itself uses Electron as a Node
// runtime), two env vars are inherited:
//
//   ELECTRON_RUN_AS_NODE=1
//   ELECTRON_NO_ATTACH_CONSOLE=1
//
// With these set, Electron boots as a plain Node runtime instead of as an
// Electron main process. `require('electron')` then returns the binary path
// string instead of the API object, and the app crashes at first access to
// `app.whenReady()` with "Cannot read properties of undefined".
//
// This wrapper deletes the vars before spawning electron-vite, so the child
// Electron process inherits a clean env and boots normally.
//
// Usage: `node scripts/dev.mjs <electron-vite-subcommand>`
// Example: `node scripts/dev.mjs dev` or `node scripts/dev.mjs preview`

import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE
delete process.env.ELECTRON_NO_ATTACH_CONSOLE

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('[dev.mjs] expected an electron-vite subcommand (dev | preview | build)')
  process.exit(1)
}

const child = spawn('electron-vite', args, {
  stdio: 'inherit',
  shell: true,
  env: process.env
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[dev.mjs] failed to spawn electron-vite:', err)
  process.exit(1)
})
