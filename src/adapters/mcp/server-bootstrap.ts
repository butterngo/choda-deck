import * as fs from 'fs'
import * as path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { resolveDataPaths } from '../../core/paths'
import * as taskTools from './mcp-tools/task-tools'
import * as conversationTools from './mcp-tools/conversation-tools'
import * as projectTools from './mcp-tools/project-tools'
import * as workspaceTools from './mcp-tools/workspace-tools'
import * as sessionTools from './mcp-tools/session-tools'
import * as inboxTools from './mcp-tools/inbox-tools'
import * as backupTools from './mcp-tools/backup-tools'
import * as knowledgeTools from './mcp-tools/knowledge-tools'

export async function startMcpServer(): Promise<void> {
  const { dbPath, dataDir } = resolveDataPaths()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const svc = new SqliteTaskService(dbPath)
  await svc.initializeAsync()

  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )

  taskTools.register(server, svc)
  conversationTools.register(server, svc)
  projectTools.register(server, svc)
  workspaceTools.register(server, svc)
  sessionTools.register(server, svc)
  inboxTools.register(server, svc)
  backupTools.register(server, svc, dataDir, dbPath)
  knowledgeTools.register(server, svc)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
