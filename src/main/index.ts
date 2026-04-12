import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { spawn, ChildProcess } from 'child_process'
import * as pty from 'node-pty'
import icon from '../../resources/icon.png?asset'

const is = {
  get dev(): boolean {
    return !app.isPackaged
  }
}

// ── Project config (projects.json) ─────────────────────────────────────────────

interface ProjectEntry {
  id: string
  cwd: string
  shell: string
}

const DEFAULT_SHELL = process.platform === 'win32' ? 'claude.cmd' : 'claude'

function getProjectsPath(): string {
  const dir = app.isPackaged ? app.getPath('userData') : join(__dirname, '../..')
  return join(dir, 'projects.json')
}

function loadProjects(): ProjectEntry[] {
  const filePath = getProjectsPath()
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    return (raw as Array<{ id: string; cwd: string; shell?: string }>).map((p) => ({
      id: p.id,
      cwd: p.cwd,
      shell: p.shell || DEFAULT_SHELL
    }))
  } catch {
    return []
  }
}

function saveProjects(projects: ProjectEntry[]): void {
  const filePath = getProjectsPath()
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(projects, null, 2), 'utf-8')
}

let projects: ProjectEntry[] = []

// ── Plugin config (plugins.json) ──────────────────────────────────────────────

interface PluginEntry {
  id: string
  type: 'mcp'
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  enabled: boolean
}

function getPluginsPath(): string {
  const dir = app.isPackaged ? app.getPath('userData') : join(__dirname, '../..')
  return join(dir, 'plugins.json')
}

function loadPlugins(): PluginEntry[] {
  const filePath = getPluginsPath()
  if (!existsSync(filePath)) return []
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    return (raw as PluginEntry[]).map((p) => ({
      id: p.id,
      type: p.type || 'mcp',
      command: p.command,
      args: p.args || [],
      cwd: p.cwd,
      env: p.env,
      enabled: p.enabled !== false
    }))
  } catch {
    return []
  }
}

function savePlugins(list: PluginEntry[]): void {
  const filePath = getPluginsPath()
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(list, null, 2), 'utf-8')
}

let plugins: PluginEntry[] = []

// ── MCP server lifecycle ──────────────────────────────────────────────────────

interface McpProcess {
  plugin: PluginEntry
  process: ChildProcess
  status: 'running' | 'stopped' | 'error'
}

const mcpProcesses = new Map<string, McpProcess>()

function startMcpServer(plugin: PluginEntry): McpProcess | null {
  if (mcpProcesses.has(plugin.id)) return mcpProcesses.get(plugin.id)!
  if (!plugin.enabled) return null

  const cwd = plugin.cwd || join(__dirname, '../..')
  const env = { ...process.env, ...(plugin.env || {}) } as NodeJS.ProcessEnv

  const child = spawn(plugin.command, plugin.args, {
    cwd,
    env,
    stdio: 'pipe',
    shell: true
  })

  const entry: McpProcess = { plugin, process: child, status: 'running' }

  child.on('exit', (code) => {
    entry.status = code === 0 ? 'stopped' : 'error'
  })

  child.on('error', () => {
    entry.status = 'error'
  })

  mcpProcesses.set(plugin.id, entry)
  return entry
}

function stopMcpServer(id: string): void {
  const entry = mcpProcesses.get(id)
  if (!entry) return
  try {
    entry.process.kill()
  } catch { /* ignore */ }
  entry.status = 'stopped'
  mcpProcesses.delete(id)
}

function stopAllMcpServers(): void {
  for (const [id] of mcpProcesses) {
    stopMcpServer(id)
  }
}

function getMcpStatus(id: string): string {
  const entry = mcpProcesses.get(id)
  if (!entry) return 'stopped'
  return entry.status
}

function startEnabledMcpServers(): void {
  for (const plugin of plugins) {
    if (plugin.enabled) {
      startMcpServer(plugin)
    }
  }
}

function generateClaudeConfig(): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {}
  for (const plugin of plugins) {
    if (plugin.enabled && plugin.type === 'mcp') {
      mcpServers[plugin.id] = {
        command: plugin.command,
        args: plugin.args,
        cwd: plugin.cwd || join(__dirname, '../..'),
        env: plugin.env || {}
      }
    }
  }
  return { mcpServers }
}

function writeClaudeConfigForProject(projectCwd: string): void {
  const config = generateClaudeConfig()
  if (Object.keys(config.mcpServers as object).length === 0) return

  const configPath = join(projectCwd, '.claude.json')
  // Read existing config if any, merge mcpServers
  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch { /* ignore */ }
  }
  existing.mcpServers = {
    ...((existing.mcpServers as Record<string, unknown>) || {}),
    ...(config.mcpServers as Record<string, unknown>)
  }
  writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8')
}

// R11: PATH fallback — ensure common CLI install locations are in PATH
function ensurePath(): void {
  const currentPath = process.env.PATH || ''
  const extraPaths: string[] = []

  if (process.platform === 'win32') {
    // npm global, AppData local, common install dirs
    const appData = process.env.APPDATA || ''
    const localAppData = process.env.LOCALAPPDATA || ''
    const candidates = [
      join(appData, 'npm'),
      join(localAppData, 'Programs', 'claude-code'),
      'C:\\Program Files\\nodejs'
    ]
    for (const p of candidates) {
      if (existsSync(p) && !currentPath.includes(p)) {
        extraPaths.push(p)
      }
    }
  } else {
    // macOS/Linux: homebrew, nvm, npm global
    const home = process.env.HOME || ''
    const candidates = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(home, '.nvm/versions/node'),
      join(home, '.npm-global/bin')
    ]
    for (const p of candidates) {
      if (existsSync(p) && !currentPath.includes(p)) {
        extraPaths.push(p)
      }
    }
  }

  if (extraPaths.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = currentPath + sep + extraPaths.join(sep)
  }
}

// Map of session id -> running pty process
const sessions = new Map<string, pty.IPty>()

function createPtySession(id: string, cwd: string, cols: number, rows: number, webContents: Electron.WebContents): void {
  if (sessions.has(id)) {
    // Already exists — don't respawn
    return
  }

  // Lazy-start: write .claude.json with MCP config + start MCP servers
  writeClaudeConfigForProject(cwd)
  startEnabledMcpServers()

  const project = projects.find(p => p.id === id)
  const shellCmd = project ? project.shell : DEFAULT_SHELL
  const ptyProcess = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      NEO4J_PASSWORD: process.env.NEO4J_PASSWORD || 'yourpassword'
    } as { [key: string]: string }
  })

  ptyProcess.onData((data) => {
    if (!webContents.isDestroyed()) {
      webContents.send(`pty:data:${id}`, data)
    }
  })

  ptyProcess.onExit(({ exitCode }) => {
    if (!webContents.isDestroyed()) {
      webContents.send(`pty:exit:${id}`, exitCode)
    }
    sessions.delete(id)
  })

  sessions.set(id, ptyProcess)
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    title: 'Choda Deck',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('dev.choda.deck')

  // Dev-mode shortcuts: F12 toggles devtools. Skipped for packaged builds.
  app.on('browser-window-created', (_, window) => {
    if (!app.isPackaged) {
      window.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') {
          window.webContents.toggleDevTools()
          event.preventDefault()
        }
      })
    }
  })

  // PTY IPC handlers
  ipcMain.handle('pty:spawn', (event, id: string, cwd: string, cols: number, rows: number) => {
    createPtySession(id, cwd, cols, rows, event.sender)
    return { ok: true, id }
  })

  ipcMain.on('pty:input', (_event, id: string, data: string) => {
    const session = sessions.get(id)
    if (session) session.write(data)
  })

  ipcMain.on('pty:resize', (_event, id: string, cols: number, rows: number) => {
    const session = sessions.get(id)
    if (session) session.resize(cols, rows)
  })

  ipcMain.on('pty:kill', (_event, id: string) => {
    const session = sessions.get(id)
    if (session) {
      session.kill()
      sessions.delete(id)
    }
  })

  ensurePath()
  projects = loadProjects()
  plugins = loadPlugins()

  // Project management IPC
  ipcMain.handle('project:list', () => projects)

  ipcMain.handle('project:add', (_event, id: string, cwd: string) => {
    if (projects.some(p => p.id === id)) {
      return { ok: false, error: `Project "${id}" already exists` }
    }
    const entry: ProjectEntry = { id, cwd, shell: DEFAULT_SHELL }
    projects.push(entry)
    saveProjects(projects)
    return { ok: true, project: entry }
  })

  ipcMain.handle('project:remove', (_event, id: string) => {
    const idx = projects.findIndex(p => p.id === id)
    if (idx === -1) {
      return { ok: false, error: `Project "${id}" not found` }
    }
    // Kill session if running
    const session = sessions.get(id)
    if (session) {
      session.kill()
      sessions.delete(id)
    }
    projects.splice(idx, 1)
    saveProjects(projects)
    return { ok: true }
  })

  // Plugin management IPC
  ipcMain.handle('plugin:list', () => plugins)

  ipcMain.handle('plugin:add', (_event, entry: PluginEntry) => {
    if (plugins.some(p => p.id === entry.id)) {
      return { ok: false, error: `Plugin "${entry.id}" already exists` }
    }
    const plugin: PluginEntry = {
      id: entry.id,
      type: entry.type || 'mcp',
      command: entry.command,
      args: entry.args || [],
      cwd: entry.cwd,
      env: entry.env,
      enabled: entry.enabled !== false
    }
    plugins.push(plugin)
    savePlugins(plugins)
    return { ok: true, plugin }
  })

  ipcMain.handle('plugin:remove', (_event, id: string) => {
    const idx = plugins.findIndex(p => p.id === id)
    if (idx === -1) {
      return { ok: false, error: `Plugin "${id}" not found` }
    }
    plugins.splice(idx, 1)
    savePlugins(plugins)
    return { ok: true }
  })

  ipcMain.handle('plugin:status', (_event, id: string) => {
    return { id, status: getMcpStatus(id) }
  })

  ipcMain.handle('plugin:statuses', () => {
    return plugins.map(p => ({ id: p.id, enabled: p.enabled, status: getMcpStatus(p.id) }))
  })

  ipcMain.handle('plugin:restart', (_event, id: string) => {
    stopMcpServer(id)
    const plugin = plugins.find(p => p.id === id)
    if (!plugin) return { ok: false, error: `Plugin "${id}" not found` }
    startMcpServer(plugin)
    return { ok: true }
  })

  ipcMain.handle('plugin:toggle', (_event, id: string) => {
    const plugin = plugins.find(p => p.id === id)
    if (!plugin) {
      return { ok: false, error: `Plugin "${id}" not found` }
    }
    plugin.enabled = !plugin.enabled
    savePlugins(plugins)
    // Start or stop MCP server accordingly
    if (plugin.enabled) {
      startMcpServer(plugin)
    } else {
      stopMcpServer(id)
    }
    return { ok: true, enabled: plugin.enabled }
  })

  // Legacy spike handlers (backwards compat)
  ipcMain.handle('spike:project', () => projects[0] || null)
  ipcMain.handle('spike:projects', () => projects)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  // Stop all MCP servers
  stopAllMcpServers()

  // Graceful shutdown: send SIGINT first, wait, then force kill
  const pending: Array<Promise<void>> = []

  for (const [, session] of sessions.entries()) {
    pending.push(
      new Promise<void>((resolve) => {
        try {
          // Send Ctrl+C (SIGINT equivalent)
          session.write('\x03')
          const timeout = setTimeout(() => {
            try { session.kill() } catch { /* ignore */ }
            resolve()
          }, 2000)
          session.onExit(() => {
            clearTimeout(timeout)
            resolve()
          })
        } catch {
          resolve()
        }
      })
    )
  }

  // Wait for all sessions to exit (max 2s each)
  await Promise.all(pending)
  sessions.clear()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
