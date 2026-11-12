/**
 * Backfill knowledge_index embeddings — kept as an entry point for the docs
 * that name it. The logic lives in `choda-deck knowledge backfill`
 * (src/adapters/cli/knowledge-backfill-command.ts, TASK-3261): this script
 * used to restate the provider id and model options, and drifted from the
 * provider the server searches with (TASK-3203).
 *
 * Usage:
 *   pnpm run build:cli && node scripts/backfill-embeddings.mjs
 *
 * Env: CHODA_DATA_DIR / CHODA_DB_PATH, as for the MCP server.
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'dist', 'cli.cjs')
if (!fs.existsSync(cli)) {
  console.error(`[backfill] ${cli} not found — run \`pnpm run build:cli\` first`)
  process.exit(1)
}
const r = spawnSync(process.execPath, [cli, 'knowledge', 'backfill'], { stdio: 'inherit' })
process.exit(r.status ?? 1)
