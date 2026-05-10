#!/usr/bin/env node
/**
 * choda-deck CLI v1 — verifiable read-only commands + MCP server entry.
 *
 * Subcommands:
 *   task list | task show <id>
 *   inbox list
 *   knowledge list | knowledge show <slug>
 *   project context <id>
 *   mcp serve
 *
 * Env vars (forwarded to service factory):
 *   CHODA_DATA_DIR     — data root (database/, artifacts/, backups/ derived)
 *   CHODA_DB_PATH      — legacy override (logs warning)
 *   CHODA_CONTENT_ROOT — required for file reads in project context
 */

import { runTaskList, taskListHelp } from './commands/task-list'
import { runTaskShow, taskShowHelp } from './commands/task-show'
import { runInboxList, inboxListHelp } from './commands/inbox-list'
import { runKnowledgeList, knowledgeListHelp } from './commands/knowledge-list'
import { runKnowledgeShow, knowledgeShowHelp } from './commands/knowledge-show'
import { runProjectContext, projectContextHelp } from './commands/project-context'
import { runRunCommand, runCommandHelp } from './commands/run'
import { runRunQueueCommand } from './commands/run-queue'
import { runSyncExport, syncExportHelp } from './commands/sync-export'
import { runSyncImport, syncImportHelp } from './commands/sync-import'

const VERSION = '0.2.0'

const ROOT_HELP = `choda-deck v${VERSION}

Usage: choda-deck <command> [subcommand] [options]

Core read commands:
  task list              List tasks filtered by status
  task show <id>         Show task details + body + linked conversations
  inbox list             List inbox items
  knowledge list         List knowledge entries
  knowledge show <slug>  Show knowledge entry body
  project context <id>   Compile project context (architecture, state, decisions)

Executor commands:
  run <taskId>           Run Playwright FE test executor pilot (Coder + Tester)
  run-queue              Run autonomous queue of READY auto-safe tasks (ADR-019)

Cross-device sync:
  sync export --to <dir>   Write a content-stable snapshot to <dir>
  sync import --from <dir> Apply a snapshot atomically (--dry-run, --yes)

MCP server:
  mcp serve              Start MCP stdio server (replaces legacy mcp-server bin)

Meta:
  --help                 Show this help
  --version              Print version

Reading freshness:
  CLI reads SQLite directly. While the MCP server is actively writing,
  reads may lag a few seconds (WAL snapshot timing). Re-run after 1-2s
  if state looks stale. See knowledge entry sqlite-wal-read-consistency.

Pass --json to any read command for machine-readable output.
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
    case 'task':
      return dispatchTask(sub, rest)
    case 'inbox':
      return dispatchInbox(sub, rest)
    case 'knowledge':
      return dispatchKnowledge(sub, rest)
    case 'project':
      return dispatchProject(sub, rest)
    case 'run':
      return dispatchRun(sub, rest)
    case 'run-queue':
      return runRunQueueCommand(sub === undefined ? [] : [sub, ...rest])
    case 'sync':
      return dispatchSync(sub, rest)
    case 'mcp':
      return dispatchMcp(sub)
    default:
      process.stderr.write(`error: unknown command "${group}"\n\n${ROOT_HELP}`)
      return 2
  }
}

async function dispatchTask(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'list':
      return runTaskList(rest)
    case 'show':
      return runTaskShow(rest)
    case '--help':
      process.stdout.write(`${taskListHelp}\n${taskShowHelp}`)
      return 0
    case undefined:
      process.stderr.write(`error: missing task subcommand (list | show)\n\n${taskListHelp}\n${taskShowHelp}`)
      return 2
    default:
      process.stderr.write(`error: unknown task subcommand "${sub}"\n`)
      return 2
  }
}

async function dispatchInbox(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'list':
      return runInboxList(rest)
    case '--help':
      process.stdout.write(inboxListHelp)
      return 0
    case undefined:
      process.stderr.write(`error: missing inbox subcommand (list)\n\n${inboxListHelp}`)
      return 2
    default:
      process.stderr.write(`error: unknown inbox subcommand "${sub}"\n`)
      return 2
  }
}

async function dispatchKnowledge(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'list':
      return runKnowledgeList(rest)
    case 'show':
      return runKnowledgeShow(rest)
    case '--help':
      process.stdout.write(`${knowledgeListHelp}\n${knowledgeShowHelp}`)
      return 0
    case undefined:
      process.stderr.write(`error: missing knowledge subcommand (list | show)\n\n${knowledgeListHelp}\n${knowledgeShowHelp}`)
      return 2
    default:
      process.stderr.write(`error: unknown knowledge subcommand "${sub}"\n`)
      return 2
  }
}

async function dispatchProject(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'context':
      return runProjectContext(rest)
    case '--help':
      process.stdout.write(projectContextHelp)
      return 0
    case undefined:
      process.stderr.write(`error: missing project subcommand (context)\n\n${projectContextHelp}`)
      return 2
    default:
      process.stderr.write(`error: unknown project subcommand "${sub}"\n`)
      return 2
  }
}

async function dispatchRun(sub: string | undefined, rest: string[]): Promise<number> {
  if (sub === '--help') {
    process.stdout.write(runCommandHelp)
    return 0
  }
  if (sub === undefined) {
    process.stderr.write(`error: missing task id\n\n${runCommandHelp}`)
    return 2
  }
  // For "run", `sub` is the taskId positional. Forward sub + rest.
  return runRunCommand([sub, ...rest])
}

async function dispatchSync(sub: string | undefined, rest: string[]): Promise<number> {
  switch (sub) {
    case 'export':
      return runSyncExport(rest)
    case 'import':
      return runSyncImport(rest)
    case '--help':
      process.stdout.write(`${syncExportHelp}\n${syncImportHelp}`)
      return 0
    case undefined:
      process.stderr.write(
        `error: missing sync subcommand (export | import)\n\n${syncExportHelp}\n${syncImportHelp}`
      )
      return 2
    default:
      process.stderr.write(`error: unknown sync subcommand "${sub}"\n`)
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
    // alive via active stdin handles. Read commands have no lingering handles
    // and Node exits naturally with this code.
    process.exitCode = code
  })
  .catch((err) => {
    process.stderr.write(`choda-deck: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
