#!/usr/bin/env node
/**
 * MCP Task Server bin entry — DEPRECATED alias preserved for backward compat
 * with existing .claude.json configs pointing at dist/mcp-server.cjs.
 *
 * New deployments should use `choda-deck mcp serve` (see src/adapters/cli/index.ts).
 * This alias will be removed in v0.2.
 *
 * Env: CHODA_DATA_DIR — data root (database/, artifacts/, backups/ derived)
 *      CHODA_DB_PATH  — legacy override for DB path only
 *      CHODA_CONTENT_ROOT — required for file reads
 */

import { startMcpServer } from './server-bootstrap'

process.stderr.write(
  '[choda-deck] DEPRECATED: dist/mcp-server.cjs will be removed in v0.2. ' +
    'Update your MCP config to run `choda-deck mcp serve` instead.\n'
)

startMcpServer().catch((err) => {
  console.error('MCP Task Server failed:', err)
  process.exit(1)
})
