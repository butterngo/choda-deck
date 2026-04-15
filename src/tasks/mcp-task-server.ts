#!/usr/bin/env node
/**
 * MCP Task Server — exposes SQLite task management as MCP tools.
 * Run: npx ts-node src/tasks/mcp-task-server.ts
 * Env: CHODA_DB_PATH (default: ./choda-deck.db)
 *      CHODA_CONTENT_ROOT (default: none — required for file reads)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SqliteTaskService } from './sqlite-task-service'
import * as taskTools from './mcp-tools/task-tools'
import * as phaseTools from './mcp-tools/phase-tools'
import * as featureTools from './mcp-tools/feature-tools'
import * as roadmapTool from './mcp-tools/roadmap-tool'
import * as searchTool from './mcp-tools/search-tool'
import * as conversationTools from './mcp-tools/conversation-tools'
import * as projectTools from './mcp-tools/project-tools'

const DB_PATH = process.env.CHODA_DB_PATH || './choda-deck.db'

async function main(): Promise<void> {
  const svc = new SqliteTaskService(DB_PATH)

  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )

  taskTools.register(server, svc)
  phaseTools.register(server, svc)
  featureTools.register(server, svc)
  roadmapTool.register(server, svc)
  searchTool.register(server, svc)
  conversationTools.register(server, svc)
  projectTools.register(server, svc)

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('MCP Task Server failed:', err)
  process.exit(1)
})
