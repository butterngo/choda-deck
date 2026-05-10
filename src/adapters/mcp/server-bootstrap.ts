import * as fs from 'fs'
import * as path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { resolveDataPaths } from '../../core/paths'
import { createInstrumentedServer } from './instrumented-server'
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

export async function startMcpServer(): Promise<void> {
  const { dbPath, dataDir } = resolveDataPaths()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const svc = new SqliteTaskService(dbPath)
  await svc.initializeAsync()

  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )
  const instrumented = createInstrumentedServer(server, svc)

  taskTools.register(instrumented, svc)
  conversationTools.register(instrumented, svc)
  projectTools.register(instrumented, svc)
  workspaceTools.register(instrumented, svc)
  sessionTools.register(instrumented, svc)
  inboxTools.register(instrumented, svc)
  backupTools.register(instrumented, svc, dataDir, dbPath)
  knowledgeTools.register(instrumented, svc)
  statsTools.register(instrumented, svc)
  cleanupTools.register(instrumented, svc)

  // TASK-681: catch missed migrations to instrumented facade — count must be
  // non-zero, otherwise registration silently bypassed instrumentation.
  console.error(`[choda-deck] registered ${instrumented.registeredToolNames.length} MCP tools`)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
