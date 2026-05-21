import * as fs from 'fs'
import * as path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { resolveDataPaths } from '../../core/paths'
import { createInstrumentedServer } from './instrumented-server'
import { startHttpTransport } from './http-transport'
import * as taskTools from './mcp-tools/task-tools'
import * as conversationTools from './mcp-tools/conversation-tools'
import * as projectTools from './mcp-tools/project-tools'
import * as workspaceTools from './mcp-tools/workspace-tools'
import * as sessionTools from './mcp-tools/session-tools'
import * as inboxTools from './mcp-tools/inbox-tools'
import * as backupTools from './mcp-tools/backup-tools'
import * as knowledgeTools from './mcp-tools/knowledge-tools'
import * as statsTools from './mcp-tools/stats-tools'
import * as cleanupTools from './mcp-tools/cleanup-tools'
import * as cleanupArtifacts from './mcp-tools/cleanup-artifacts'
import * as sessionEventAddTools from './mcp-tools/session-event-add'
import * as sessionEventListTools from './mcp-tools/session-event-list'
import * as memoryWriteTools from './mcp-tools/memory-write'
import * as memoryRecallTools from './mcp-tools/memory-recall'
import * as memoryPromoteTools from './mcp-tools/memory-promote-to-knowledge'
import * as taskApproveTools from './mcp-tools/task-approve'
import * as taskRejectTools from './mcp-tools/task-reject'

interface BuildDeps {
  svc: SqliteTaskService
  dataDir: string
  artifactsDir: string
  dbPath: string
}

function buildMcpServer(deps: BuildDeps): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )
  const instrumented = createInstrumentedServer(server, deps.svc)

  taskTools.register(instrumented, deps.svc)
  conversationTools.register(instrumented, deps.svc)
  projectTools.register(instrumented, deps.svc)
  workspaceTools.register(instrumented, deps.svc)
  sessionTools.register(instrumented, deps.svc)
  inboxTools.register(instrumented, deps.svc)
  backupTools.register(instrumented, deps.svc, deps.dataDir, deps.dbPath)
  knowledgeTools.register(instrumented, deps.svc)
  statsTools.register(instrumented, deps.svc)
  cleanupTools.register(instrumented, deps.svc)
  cleanupArtifacts.register(instrumented, deps.artifactsDir)
  sessionEventAddTools.register(instrumented, deps.svc)
  sessionEventListTools.register(instrumented, deps.svc)
  memoryWriteTools.register(instrumented, deps.svc)
  memoryRecallTools.register(instrumented, deps.svc)
  memoryPromoteTools.register(instrumented, deps.svc)
  taskApproveTools.register(instrumented, deps.svc)
  taskRejectTools.register(instrumented, deps.svc)

  return { server, toolCount: instrumented.registeredToolNames.length }
}

export async function startMcpServer(): Promise<void> {
  const { dbPath, dataDir, artifactsDir } = resolveDataPaths()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const svc = new SqliteTaskService(dbPath)
  await svc.initializeAsync()
  const deps: BuildDeps = { svc, dataDir, artifactsDir, dbPath }

  const mode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()

  if (mode === 'http') {
    const token = process.env.MCP_HTTP_TOKEN ?? ''
    if (token.length === 0) {
      process.stderr.write(
        '[choda-deck] MCP_TRANSPORT=http requires MCP_HTTP_TOKEN — refusing to expose unauthenticated\n'
      )
      process.exit(2)
    }
    const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? '7337', 10)
    const bind = process.env.MCP_HTTP_BIND ?? '0.0.0.0'
    // Log tool count once at startup to keep parity with stdio mode logging.
    const { toolCount } = buildMcpServer(deps)
    console.error(`[choda-deck] registered ${toolCount} MCP tools`)
    await startHttpTransport(() => buildMcpServer(deps).server, { port, bind, token })
    return
  }

  if (mode !== 'stdio') {
    process.stderr.write(`[choda-deck] unknown MCP_TRANSPORT="${mode}" — expected stdio|http\n`)
    process.exit(2)
  }

  const { server, toolCount } = buildMcpServer(deps)
  // TASK-681: catch missed migrations to instrumented facade — count must be
  // non-zero, otherwise registration silently bypassed instrumentation.
  console.error(`[choda-deck] registered ${toolCount} MCP tools`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
