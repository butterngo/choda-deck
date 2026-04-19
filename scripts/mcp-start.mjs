#!/usr/bin/env node
// Runs the MCP task server using Electron's embedded Node runtime.
//
// Why: `postinstall` runs `electron-builder install-app-deps`, which rebuilds
// better-sqlite3 for Electron's Node version.  System Node has a different
// NODE_MODULE_VERSION and cannot load the native addon.  Setting
// ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as a plain Node
// runtime whose version matches the compiled addon.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const electronPath = String(require('electron'))

const child = spawn(electronPath, ['-r', 'ts-node/register', 'src/tasks/mcp-task-server.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    TS_NODE_PROJECT: 'tsconfig.node.json',
    TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node"}'
  }
})

child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (err) => {
  console.error('[mcp-start] failed to spawn Electron-as-Node:', err)
  process.exit(1)
})
