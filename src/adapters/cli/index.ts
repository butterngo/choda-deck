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

const VERSION = '0.2.0'

const ROOT_HELP = `choda-deck v${VERSION}

Usage: choda-deck <command> [options]

Commands:
  mcp serve     Start MCP server (set MCP_TRANSPORT=http for Streamable HTTP)

Meta:
  --help        Show this help
  --version     Print version
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
    default:
      process.stderr.write(`error: unknown command "${group}"\n\n${ROOT_HELP}`)
      return 2
  }
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
