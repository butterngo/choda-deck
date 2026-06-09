import * as fs from 'fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { BackendTaskService } from '../../core/domain/backend-task-service.interface'
import {
  createTaskService,
  requireBackendForTransport
} from '../../core/domain/task-service-factory'
import { resolveBackendConfig, resolveDataPaths } from '../../core/paths'
import {
  createInstrumentedServer,
  type ToolInvocationSink
} from './instrumented-server'
import { startHttpTransport, type OAuthConfig } from './http-transport'
import { createKeycloakVerifier } from './oauth/jwt-verifier'
import * as taskTools from './mcp-tools/task-tools'
import * as conversationTools from './mcp-tools/conversation-tools'
import * as projectTools from './mcp-tools/project-tools'
import * as workspaceTools from './mcp-tools/workspace-tools'
import * as sessionTools from './mcp-tools/session-tools'
import * as inboxTools from './mcp-tools/inbox-tools'
import * as investigationTools from './mcp-tools/investigation-tools'
import * as backupTools from './mcp-tools/backup-tools'
import * as knowledgeTools from './mcp-tools/knowledge-tools'
import * as codeRefTools from './mcp-tools/code-ref-tools'
import * as graphTools from './mcp-tools/graph-tools'
import * as featureProjectionTools from './mcp-tools/feature-projection-tools'
import * as statsTools from './mcp-tools/stats-tools'
import * as cleanupTools from './mcp-tools/cleanup-tools'
import * as cleanupArtifacts from './mcp-tools/cleanup-artifacts'
import * as sessionEventAddTools from './mcp-tools/session-event-add'
import * as sessionEventListTools from './mcp-tools/session-event-list'
import * as memoryWriteTools from './mcp-tools/memory-write'
import * as memoryRecallTools from './mcp-tools/memory-recall'
import * as memoryPromoteTools from './mcp-tools/memory-promote-to-knowledge'
import * as acCheckTools from './mcp-tools/ac-check'

interface BuildDeps {
  svc: BackendTaskService
  dataDir: string
  artifactsDir: string
  dbPath: string
}

// Tools exposed when MCP_TRANSPORT=http. Stdio keeps the full surface (local
// trust). HTTP is network-exposed and the PG backend implements only
// RemoteOperations — methods outside this set would throw at runtime if
// invoked. See ADR-026 §Per-tool scoping standing rule (2026-05-28).
//
// Expanding the allowlist requires three coordinated edits in the same PR:
//   1. add the tool name here
//   2. add the methods it calls to src/core/domain/remote-operations.interface.ts
//   3. implement those methods on PostgresTaskService + add any missing repos/migrations
export const REMOTE_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'project_list',
  'task_list',
  'task_context',
  'inbox_list',
  'inbox_get',
  'inbox_add'
])

// HTTP mode skips tool-invocation telemetry — the table doesn't exist on the
// PG schema (deleted with the rest of the stdio-only surface) and per-tool
// stats are a local-development concern. Stdio passes the svc itself as the
// sink (SqliteTaskService implements recordToolInvocation).
const noopSink: ToolInvocationSink = { recordToolInvocation: (): void => {} }

function buildMcpServer(
  deps: BuildDeps,
  toolAllowlist?: ReadonlySet<string>,
  sink?: ToolInvocationSink
): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: 'choda-tasks', version: '0.2.0' },
    { capabilities: { tools: {} } }
  )
  const instrumented = createInstrumentedServer(server, sink ?? deps.svc, toolAllowlist)

  taskTools.register(instrumented, deps.svc)
  conversationTools.register(instrumented, deps.svc)
  projectTools.register(instrumented, deps.svc)
  workspaceTools.register(instrumented, deps.svc)
  sessionTools.register(instrumented, deps.svc)
  inboxTools.register(instrumented, deps.svc)
  // ADR-035: stdio-only — deliberately absent from REMOTE_TOOL_ALLOWLIST above.
  investigationTools.register(instrumented, deps.svc)
  backupTools.register(instrumented, deps.svc, deps.dataDir, deps.dbPath)
  knowledgeTools.register(instrumented, deps.svc)
  codeRefTools.register(instrumented, deps.svc)
  graphTools.register(instrumented, deps.svc)
  featureProjectionTools.register(instrumented, deps.svc)
  statsTools.register(instrumented, deps.svc)
  cleanupTools.register(instrumented, deps.svc)
  cleanupArtifacts.register(instrumented, deps.artifactsDir)
  sessionEventAddTools.register(instrumented, deps.svc)
  sessionEventListTools.register(instrumented, deps.svc)
  memoryWriteTools.register(instrumented, deps.svc)
  memoryRecallTools.register(instrumented, deps.svc)
  memoryPromoteTools.register(instrumented, deps.svc)
  acCheckTools.register(instrumented, deps.svc)

  return { server, toolCount: instrumented.registeredToolNames.length }
}

export async function startMcpServer(): Promise<void> {
  const dataPaths = resolveDataPaths()
  const backend = resolveBackendConfig(dataPaths)
  const mode = (process.env.MCP_TRANSPORT ?? 'stdio').toLowerCase()

  if (mode !== 'stdio' && mode !== 'http') {
    process.stderr.write(`[choda-deck] unknown MCP_TRANSPORT="${mode}" — expected stdio|http\n`)
    process.exit(2)
  }

  requireBackendForTransport(backend, mode)

  const svc = createTaskService(backend)
  await svc.initializeAsync()
  const deps: BuildDeps = {
    svc,
    dataDir: dataPaths.dataDir,
    artifactsDir: dataPaths.artifactsDir,
    dbPath: dataPaths.dbPath
  }

  if (mode === 'http') {
    const oauth = buildOAuthConfig()
    const token = process.env.MCP_HTTP_TOKEN ?? ''
    if (!oauth && token.length === 0) {
      process.stderr.write(
        '[choda-deck] MCP_TRANSPORT=http requires MCP_HTTP_TOKEN (or MCP_OAUTH_MODE=1 + Keycloak config) — refusing to expose unauthenticated\n'
      )
      process.exit(2)
    }
    const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? '7337', 10)
    const bind = process.env.MCP_HTTP_BIND ?? '0.0.0.0'
    // Compute total (unfiltered) for the "X of Y" boot log so a misconfigured
    // allowlist is obvious in startup output.
    const { toolCount: totalToolCount } = buildMcpServer(deps)
    const { toolCount: allowedToolCount } = buildMcpServer(deps, REMOTE_TOOL_ALLOWLIST, noopSink)
    console.error(
      `[choda-deck] registered ${allowedToolCount} MCP tools ` +
        `(remote allowlist: ${REMOTE_TOOL_ALLOWLIST.size} of ${totalToolCount})`
    )
    await startHttpTransport(
      () => buildMcpServer(deps, REMOTE_TOOL_ALLOWLIST, noopSink).server,
      {
        port,
        bind,
        token,
        oauth
      }
    )
    return
  }

  const { server, toolCount } = buildMcpServer(deps)
  // TASK-681: catch missed migrations to instrumented facade — count must be
  // non-zero, otherwise registration silently bypassed instrumentation.
  console.error(`[choda-deck] registered ${toolCount} MCP tools`)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// ADR-034: when MCP_OAUTH_MODE=1, build a Keycloak-backed OAuthConfig from env.
// choda-deck proxies /authorize, /token, /register to Keycloak and validates
// Keycloak-issued JWTs on /mcp — no local token store (ADR-027's oauth_* is gone).
//
// Required env:
//   MCP_OAUTH_ISSUER          public origin of THIS server (metadata + WWW-Authenticate)
//   MCP_OIDC_ISSUER           Keycloak realm issuer, e.g. https://id.choda.dev/realms/<realm>
//   MCP_OIDC_CLIENT_ID        pinned Keycloak public client for the connector
// Optional:
//   MCP_OIDC_AUDIENCE         expected token aud/azp (defaults to MCP_OIDC_CLIENT_ID)
//   MCP_OIDC_CLIENT_SECRET_FILE  only if the pinned client is confidential
function buildOAuthConfig(): OAuthConfig | undefined {
  if (process.env.MCP_OAUTH_MODE !== '1') return undefined

  const origin = requireEnv('MCP_OAUTH_ISSUER', 'public origin e.g. https://mcp.choda.dev').replace(
    /\/$/,
    ''
  )
  const realmIssuer = requireEnv(
    'MCP_OIDC_ISSUER',
    'Keycloak realm issuer e.g. https://id.choda.dev/realms/choda'
  ).replace(/\/$/, '')
  const clientId = requireEnv('MCP_OIDC_CLIENT_ID', 'pinned Keycloak public client id')
  const audience = process.env.MCP_OIDC_AUDIENCE ?? clientId

  const secretFile = process.env.MCP_OIDC_CLIENT_SECRET_FILE
  const clientSecret =
    secretFile && fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8').trim() : undefined

  const verifier = createKeycloakVerifier({
    issuer: realmIssuer,
    audience,
    jwksUri: `${realmIssuer}/protocol/openid-connect/certs`
  })

  return {
    origin,
    keycloak: {
      authorizationEndpoint: `${realmIssuer}/protocol/openid-connect/auth`,
      tokenEndpoint: `${realmIssuer}/protocol/openid-connect/token`,
      clientId,
      clientSecret
    },
    verifier
  }
}

function requireEnv(name: string, hint: string): string {
  const value = (process.env[name] ?? '').trim()
  if (value.length === 0) {
    process.stderr.write(`[choda-deck] MCP_OAUTH_MODE=1 requires ${name} (${hint})\n`)
    process.exit(2)
  }
  return value
}
