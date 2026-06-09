#!/usr/bin/env node
/**
 * choda-deck CLI — MCP server.
 *
 * Subcommands:
 *   mcp serve     Start MCP server (stdio by default; HTTP via MCP_TRANSPORT=http)
 *
 * Env vars (forwarded to service factory):
 *   CHODA_DATA_DIR     — data root (database/, artifacts/, backups/ derived)
 *   CHODA_DB_PATH      — legacy override (logs warning)
 *   CHODA_CONTENT_ROOT — content root for file reads
 *
 * MCP transport env vars (ADR-026):
 *   MCP_TRANSPORT      — stdio (default) | http
 *   MCP_HTTP_PORT      — HTTP listen port (default 7337)
 *   MCP_HTTP_BIND      — HTTP bind address (default 0.0.0.0)
 *   MCP_HTTP_TOKEN     — bearer token; REQUIRED when MCP_TRANSPORT=http
 */

const VERSION = '0.3.0'

const ROOT_HELP = `choda-deck v${VERSION}

Usage: choda-deck <command> [options]

Commands:
  mcp serve     Start MCP server (set MCP_TRANSPORT=http for Streamable HTTP)
  sync pull     Pull remote changes into the local SQLite DB (ADR-030 Phase 2)

Meta:
  --help        Show this help
  --version     Print version

sync pull env:
  CHODA_PULL_REMOTE_URL    Remote MCP origin, e.g. https://mcp.choda.dev (required)
  CHODA_PULL_REMOTE_TOKEN  Bearer token (falls back to MCP_HTTP_TOKEN)
  CHODA_DATA_DIR           Local data root (database/ derived)
`

async function main(): Promise<number> {
  const argv = process.argv.slice(2)

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(ROOT_HELP)
    return 0
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`choda-deck v${VERSION}\n`)
    return 0
  }

  const [group, sub] = argv

  switch (group) {
    case 'mcp':
      return dispatchMcp(sub)
    case 'sync':
      return dispatchSync(sub)
    default:
      process.stderr.write(`error: unknown command "${group}"\n\n${ROOT_HELP}`)
      return 2
  }
}

// ADR-030 Phase 2 — `sync pull`: read-only drain of remote changes into the
// local SQLite working copy. No write-through (that's parked Phases 3-6).
async function dispatchSync(sub: string | undefined): Promise<number> {
  if (sub !== 'pull') {
    process.stderr.write(`error: only "sync pull" is supported (got "${sub ?? ''}")\n`)
    return 2
  }
  const remoteUrl = process.env.CHODA_PULL_REMOTE_URL
  if (!remoteUrl) {
    process.stderr.write('error: sync pull requires CHODA_PULL_REMOTE_URL\n')
    return 2
  }
  const token = process.env.CHODA_PULL_REMOTE_TOKEN ?? process.env.MCP_HTTP_TOKEN ?? ''

  const { resolveDataPaths } = await import('../../core/paths')
  const { default: Database } = await import('better-sqlite3')
  const { initSchema } = await import('../../core/domain/repositories/schema')
  const { pull } = await import('../../core/sync/sync-pull')
  const { HttpPullSource } = await import('../../core/sync/http-pull-source')

  const { dbPath } = resolveDataPaths()
  const db = new Database(dbPath)
  try {
    initSchema(db) // idempotent — guarantees the sync columns + _sync_clock exist
    const source = new HttpPullSource({ remoteUrl, token })
    const result = await pull(db, source)
    const upserted = result.counts.reduce((n, c) => n + c.upserted, 0)
    const tombstoned = result.counts.reduce((n, c) => n + c.tombstoned, 0)
    process.stdout.write(
      `sync pull: ${upserted} upserted, ${tombstoned} tombstoned ` +
        `(cursor ${result.since} -> ${result.newCursor})\n`
    )
  } finally {
    db.close()
  }
  return 0
}

async function dispatchMcp(sub: string | undefined): Promise<number> {
  if (sub !== 'serve') {
    process.stderr.write(`error: only "mcp serve" is supported (got "${sub ?? ''}")\n`)
    return 2
  }
  const { startMcpServer } = await import('../mcp/server-bootstrap')
  await startMcpServer()
  return 0
}

main()
  .then((code) => {
    // Use exitCode (not process.exit) so `mcp serve` can keep the event loop
    // alive via active stdin handles.
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`choda-deck: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
