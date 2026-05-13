#!/usr/bin/env node
/**
 * choda-deck CLI — MCP server + autonomous queue runner.
 *
 * Subcommands:
 *   mcp serve     Start MCP stdio server
 *   run-queue     Run autonomous queue of READY auto-safe tasks (ADR-019)
 *
 * Env vars (forwarded to service factory):
 *   CHODA_DATA_DIR     — data root (database/, artifacts/, backups/ derived)
 *   CHODA_DB_PATH      — legacy override (logs warning)
 *   CHODA_CONTENT_ROOT — content root for file reads
 */

import { runRunQueueCommand } from './commands/run-queue'
import { runQueueReportCommand } from './commands/queue-report'

const VERSION = '0.2.0'

const ROOT_HELP = `choda-deck v${VERSION}

Usage: choda-deck <command> [options]

Commands:
  mcp serve           Start MCP stdio server
  run-queue           Run autonomous queue of READY auto-safe tasks (ADR-019)
  queue report <id>   Regenerate report.md for an existing artifact directory

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

  const [group, sub, ...rest] = argv

  switch (group) {
    case 'run-queue':
      return runRunQueueCommand(sub === undefined ? [] : [sub, ...rest])
    case 'mcp':
      return dispatchMcp(sub)
    case 'queue':
      return dispatchQueue(sub, rest)
    default:
      process.stderr.write(`error: unknown command "${group}"\n\n${ROOT_HELP}`)
      return 2
  }
}

async function dispatchQueue(sub: string | undefined, rest: string[]): Promise<number> {
  if (sub !== 'report') {
    process.stderr.write(`error: only "queue report" is supported (got "${sub ?? ''}")\n`)
    return 2
  }
  return runQueueReportCommand(rest)
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
    // alive via active stdin handles. run-queue has no lingering handles and
    // Node exits naturally with this code.
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`choda-deck: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
