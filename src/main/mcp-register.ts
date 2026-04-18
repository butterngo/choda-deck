import { app } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const MCP_KEY = 'choda-tasks'

interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>
  [key: string]: unknown
}

export interface McpRegisterStatus {
  registered: boolean
  path?: string
}

function claudeConfigPath(): string {
  return join(homedir(), '.claude.json')
}

function resolveMcpServerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'mcp-server.cjs')
  }
  return join(__dirname, '../..', 'dist', 'mcp-server.cjs')
}

function loadContentRoot(): string {
  try {
    const projectsPath = join(
      app.isPackaged ? app.getPath('userData') : join(__dirname, '../..'),
      'projects.json'
    )
    if (!existsSync(projectsPath)) return ''
    const raw = JSON.parse(readFileSync(projectsPath, 'utf-8'))
    return typeof raw?.contentRoot === 'string' ? raw.contentRoot : ''
  } catch {
    return ''
  }
}

function resolveDbPath(): string {
  if (app.isPackaged) {
    return join(app.getPath('userData'), 'choda-deck.db')
  }
  return join(__dirname, '../..', 'choda-deck.db')
}

function buildDesiredEntry(): McpServerEntry {
  const env: Record<string, string> = { CHODA_DB_PATH: resolveDbPath() }
  const contentRoot = loadContentRoot()
  if (contentRoot) env.CHODA_CONTENT_ROOT = contentRoot
  return { command: 'node', args: [resolveMcpServerPath()], env }
}

function readClaudeConfig(): ClaudeConfig | null {
  const target = claudeConfigPath()
  if (!existsSync(target)) return null
  try {
    const raw = readFileSync(target, 'utf-8')
    return JSON.parse(raw) as ClaudeConfig
  } catch (err) {
    console.error('[mcp-register] ~/.claude.json is not valid JSON:', err)
    return null
  }
}

function atomicWriteFile(target: string, content: string): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, target)
}

function writeClaudeConfig(cfg: ClaudeConfig): void {
  atomicWriteFile(claudeConfigPath(), JSON.stringify(cfg, null, 2) + '\n')
}

function entriesEqual(a: McpServerEntry, b: McpServerEntry): boolean {
  if (a.command !== b.command) return false
  if ((a.args?.length ?? 0) !== (b.args?.length ?? 0)) return false
  for (let i = 0; i < a.args.length; i += 1) {
    if (a.args[i] !== b.args[i]) return false
  }
  return JSON.stringify(a.env ?? {}) === JSON.stringify(b.env ?? {})
}

export function getMcpRegisterStatus(): McpRegisterStatus {
  const cfg = readClaudeConfig()
  const entry = cfg?.mcpServers?.[MCP_KEY]
  if (!entry) return { registered: false }
  return { registered: true, path: entry.args?.[0] }
}

export function ensureMcpRegistered(): void {
  if (!existsSync(claudeConfigPath())) {
    console.log('[mcp-register] ~/.claude.json not found — user does not use Claude Code, skipping')
    return
  }

  const cfg = readClaudeConfig()
  if (!cfg) return

  const desired = buildDesiredEntry()
  const current = cfg.mcpServers?.[MCP_KEY]

  if (current && entriesEqual(current, desired)) {
    console.log('[mcp-register] choda-tasks already registered with correct path')
    return
  }

  cfg.mcpServers = cfg.mcpServers ?? {}
  cfg.mcpServers[MCP_KEY] = desired
  try {
    writeClaudeConfig(cfg)
    console.log(`[mcp-register] Registered choda-tasks MCP → ${desired.args[0]}`)
  } catch (err) {
    console.error('[mcp-register] Failed to write ~/.claude.json:', err)
  }
}

export function unregisterMcp(): { ok: boolean; error?: string } {
  const cfg = readClaudeConfig()
  if (!cfg?.mcpServers?.[MCP_KEY]) return { ok: true }
  delete cfg.mcpServers[MCP_KEY]
  try {
    writeClaudeConfig(cfg)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
