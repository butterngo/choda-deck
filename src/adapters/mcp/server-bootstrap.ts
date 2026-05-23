import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import { createTaskService } from '../../core/domain/task-service-factory'
import { OAuthRepository } from '../../core/domain/repositories/oauth-repository'
import { resolveBackendConfig, resolveDataPaths } from '../../core/paths'
import { createInstrumentedServer } from './instrumented-server'
import { startHttpTransport, type OAuthConfig } from './http-transport'
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
import * as acCheckTools from './mcp-tools/ac-check'

interface BuildDeps {
  svc: BackendTaskService
  dataDir: string
  artifactsDir: string
  dbPath: string
}

// TASK-903: tools exposed when MCP_TRANSPORT=http. Stdio keeps all tools
// (local trust). HTTP is network-exposed, so the surface is narrowed to
// read + capture: enough for a mobile/remote client to browse state and
// drop new inbox items, nothing that mutates lifecycle or touches the
// knowledge / memory / research layers. See ADR-026 §Per-tool scoping.
export const REMOTE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'project_list',
  'task_list',
  'task_context',
  'inbox_list',
  'inbox_get',
  'inbox_add'
])

function buildMcpServer(
  deps: BuildDeps,
  toolAllowlist?: ReadonlySet<string>
): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )
  const instrumented = createInstrumentedServer(server, deps.svc, toolAllowlist)

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
  acCheckTools.register(instrumented, deps.svc)

  return { server, toolCount: instrumented.registeredToolNames.length }
}

export async function startMcpServer(): Promise<void> {
  const dataPaths = resolveDataPaths()
  const backend = resolveBackendConfig(dataPaths)
  const svc = createTaskService(backend)
  await svc.initializeAsync()
  const deps: BuildDeps = {
    svc,
    dataDir: dataPaths.dataDir,
    artifactsDir: dataPaths.artifactsDir,
    dbPath: dataPaths.dbPath
  }

  const mode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()

  if (mode === 'http') {
    const oauth = buildOAuthConfig(dataPaths.dbPath)
    const token = process.env.MCP_HTTP_TOKEN ?? ''
    if (!oauth && token.length === 0) {
      process.stderr.write(
        '[choda-deck] MCP_TRANSPORT=http requires MCP_HTTP_TOKEN (or MCP_OAUTH_MODE=1 + MCP_OAUTH_ISSUER) — refusing to expose unauthenticated\n'
      )
      process.exit(2)
    }
    const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? '7337', 10)
    const bind = process.env.MCP_HTTP_BIND ?? '0.0.0.0'
    // Log tool count once at startup to keep parity with stdio mode logging.
    // Compute total (unfiltered) for the "X of Y" suffix so a misconfigured
    // allowlist is obvious in the boot log.
    const { toolCount: totalToolCount } = buildMcpServer(deps)
    const { toolCount: allowedToolCount } = buildMcpServer(deps, REMOTE_TOOL_ALLOWLIST)
    console.error(
      `[choda-deck] registered ${allowedToolCount} MCP tools ` +
        `(remote allowlist: ${REMOTE_TOOL_ALLOWLIST.size} of ${totalToolCount})`
    )
    await startHttpTransport(() => buildMcpServer(deps, REMOTE_TOOL_ALLOWLIST).server, {
      port,
      bind,
      token,
      oauth
    })
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

// ADR-027: when MCP_OAUTH_MODE=1, build an OAuthConfig from env + consent
// password file. Uses a SECOND better-sqlite3 connection so SqliteTaskService
// stays untouched — WAL handles concurrency, OAuth writes are rare.
function buildOAuthConfig(dbPath: string): OAuthConfig | undefined {
  if (process.env.MCP_OAUTH_MODE !== '1') return undefined

  const issuer = (process.env.MCP_OAUTH_ISSUER ?? '').replace(/\/$/, '')
  if (issuer.length === 0) {
    process.stderr.write(
      '[choda-deck] MCP_OAUTH_MODE=1 requires MCP_OAUTH_ISSUER (e.g. https://mcp.choda.dev)\n'
    )
    process.exit(2)
  }

  const passwordFile =
    process.env.MCP_OAUTH_CONSENT_PASSWORD_FILE ??
    path.join(process.cwd(), 'sensitive_information', 'oauth-consent-password.txt')
  if (!fs.existsSync(passwordFile)) {
    process.stderr.write(
      `[choda-deck] MCP_OAUTH_MODE=1 needs consent password file at ${passwordFile}\n`
    )
    process.exit(2)
  }
  const hash = fs.readFileSync(passwordFile, 'utf8').trim()
  if (!/^[0-9a-f]{64}$/i.test(hash)) {
    process.stderr.write(
      `[choda-deck] consent password file must contain a 64-char hex SHA-256 hash (got ${hash.length} chars)\n`
    )
    process.exit(2)
  }

  const oauthDb = new Database(dbPath)
  oauthDb.pragma('foreign_keys = ON')
  const repo = new OAuthRepository(oauthDb)

  return { repo, issuer, consentPasswordHashHex: hash }
}
