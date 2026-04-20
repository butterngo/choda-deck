import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { dirname, join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { spawn as spawnProcess } from 'child_process'
import * as pty from 'node-pty'
import icon from '../../resources/icon.png?asset'
import { SqliteTaskService } from '../tasks/sqlite-task-service'
import { VaultImporter } from '../tasks/vault-importer'
import { VaultService } from '../vault/vault-service'
import {
  backupDir,
  listBackups,
  runBackup,
  shouldRunDailyBackup,
  type BackupInfo
} from './backup-service'
import { ensureMcpRegistered, getMcpRegisterStatus, unregisterMcp } from './mcp-register'
import { registerPipelineIpc } from './ipc/pipeline-ipc'

const is = {
  get dev(): boolean {
    return !app.isPackaged
  }
}

// ── Project config (projects.json) ─────────────────────────────────────────────

interface WorkspaceEntry {
  id: string
  label: string
  cwd: string
  shell?: string
}

interface ProjectEntry {
  id: string
  name: string
  workspaces: WorkspaceEntry[]
}

interface ProjectsConfig {
  contentRoot: string
  projects: ProjectEntry[]
}

const DEFAULT_SHELL = process.platform === 'win32' ? 'claude.cmd' : 'claude'

function getProjectsPath(): string {
  const dir = app.isPackaged ? app.getPath('userData') : join(__dirname, '../..')
  return join(dir, 'projects.json')
}

function loadConfig(): ProjectsConfig {
  const filePath = getProjectsPath()
  if (!existsSync(filePath)) return { contentRoot: '', projects: [] }
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))

    // New schema: { contentRoot, projects: [...] }
    if (raw.contentRoot && raw.projects) {
      return raw as ProjectsConfig
    }

    // Auto-migrate old array schema → new object schema
    const arr = raw as unknown[]
    if (arr.length > 0 && 'cwd' in (arr[0] as Record<string, unknown>)) {
      // Flat schema: [{ id, cwd }]
      return {
        contentRoot: '',
        projects: (arr as Array<{ id: string; cwd: string; shell?: string }>).map((p) => ({
          id: p.id,
          name: p.id,
          workspaces: [{ id: p.id, label: 'Main', cwd: p.cwd, shell: p.shell }]
        }))
      }
    }

    // Old hierarchy schema: [{ id, name, taskPath, workspaces }]
    return {
      contentRoot: '',
      projects: (
        arr as Array<{ id: string; name: string; taskPath?: string; workspaces: WorkspaceEntry[] }>
      ).map((p) => ({
        id: p.id,
        name: p.name,
        workspaces: p.workspaces
      }))
    }
  } catch {
    return { contentRoot: '', projects: [] }
  }
}

function saveConfig(config: ProjectsConfig): void {
  const filePath = getProjectsPath()
  const dir = join(filePath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
}

function findWorkspace(
  workspaceId: string
): { project: ProjectEntry; workspace: WorkspaceEntry } | null {
  for (const p of projects) {
    const ws = p.workspaces.find((w) => w.id === workspaceId)
    if (ws) return { project: p, workspace: ws }
  }
  return null
}

let config: ProjectsConfig = { contentRoot: '', projects: [] }
let projects: ProjectEntry[] = []

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

function createPtySession(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  webContents: Electron.WebContents
): void {
  if (sessions.has(id)) {
    // Already exists — don't respawn
    return
  }

  const found = findWorkspace(id)
  const shellCmd = found?.workspace.shell || DEFAULT_SHELL
  const ptyProcess = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as { [key: string]: string }
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

app.whenReady().then(async () => {
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
  config = loadConfig()
  projects = config.projects

  // Project management IPC
  ipcMain.handle('project:list', () => projects)

  ipcMain.handle(
    'project:add',
    (
      _event,
      projectId: string,
      name: string,
      workspaceId: string,
      workspaceLabel: string,
      cwd: string
    ) => {
      let project = projects.find((p) => p.id === projectId)
      if (!project) {
        project = { id: projectId, name, workspaces: [] }
        projects.push(project)
      }
      if (project.workspaces.some((w) => w.id === workspaceId)) {
        return { ok: false, error: `Workspace "${workspaceId}" already exists` }
      }
      project.workspaces.push({ id: workspaceId, label: workspaceLabel, cwd })
      config.projects = projects
      saveConfig(config)
      return { ok: true, project }
    }
  )

  ipcMain.handle('project:remove', (_event, projectId: string, workspaceId?: string) => {
    const projIdx = projects.findIndex((p) => p.id === projectId)
    if (projIdx === -1) {
      return { ok: false, error: `Project "${projectId}" not found` }
    }
    if (workspaceId) {
      // Remove workspace only
      const project = projects[projIdx]
      const wsIdx = project.workspaces.findIndex((w) => w.id === workspaceId)
      if (wsIdx === -1) return { ok: false, error: `Workspace "${workspaceId}" not found` }
      const session = sessions.get(workspaceId)
      if (session) {
        session.kill()
        sessions.delete(workspaceId)
      }
      project.workspaces.splice(wsIdx, 1)
      if (project.workspaces.length === 0) projects.splice(projIdx, 1)
    } else {
      // Remove entire project + all workspaces
      const project = projects[projIdx]
      for (const ws of project.workspaces) {
        const session = sessions.get(ws.id)
        if (session) {
          session.kill()
          sessions.delete(ws.id)
        }
      }
      projects.splice(projIdx, 1)
    }
    config.projects = projects
    saveConfig(config)
    return { ok: true }
  })

  // ── Task management IPC ────────────────────────────────────────────────────
  const dbPath = app.isPackaged
    ? join(app.getPath('userData'), 'choda-deck.db')
    : join(__dirname, '../../choda-deck.db')
  const userDataPath = app.isPackaged
    ? app.getPath('userData')
    : join(__dirname, '../..')
  const taskService = new SqliteTaskService(dbPath)

  // Ensure projects exist in SQLite
  for (const p of projects) {
    taskService.ensureProject(p.id, p.name, config.contentRoot)
  }

  // Daily backup — 24h gate, failures log-only
  try {
    if (shouldRunDailyBackup(userDataPath)) {
      const info = runBackup(taskService, userDataPath)
      console.log(`[backup] created ${info.filename} (${info.size} bytes)`)
    }
  } catch (err) {
    console.error('[backup] daily backup failed:', err)
  }

  ipcMain.handle('backups:list', (): BackupInfo[] => listBackups(userDataPath))

  ipcMain.handle('backups:create-now', (): { ok: boolean; backup?: BackupInfo; error?: string } => {
    try {
      const info = runBackup(taskService, userDataPath)
      return { ok: true, backup: info }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('backups:restore', (_event, filename: string): { ok: boolean; error?: string } => {
    const source = join(backupDir(userDataPath), filename)
    if (!existsSync(source)) return { ok: false, error: 'Backup file not found' }
    try {
      taskService.close()
      copyFileSync(source, dbPath)
      app.relaunch()
      app.exit(0)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // Vault import — manual trigger, not auto on boot
  let importer: VaultImporter | null = null

  ipcMain.handle('vault:import', async (_event, statusMap?: Record<string, string>) => {
    if (!config.contentRoot)
      return {
        tasks: 0,
        phases: 0,
        documents: 0,
        tags: 0,
        relationships: 0,
        skipped: 0,
        errors: ['No contentRoot configured']
      }
    importer = new VaultImporter(taskService, config.contentRoot, statusMap)
    const result = importer.importAll(projects.map((p) => p.id))
    return result
  })

  ipcMain.handle('vault:stop-watch', () => {
    if (importer) {
      importer.stopWatching()
      importer = null
    }
    return { ok: true }
  })

  ipcMain.handle('task:refresh', () => {
    if (!importer)
      return {
        tasks: 0,
        phases: 0,
        documents: 0,
        tags: 0,
        relationships: 0,
        skipped: 0,
        errors: ['No import active']
      }
    return importer.importAll(projects.map((p) => p.id))
  })

  ipcMain.handle('task:list', (_event, filter) => taskService.findTasks(filter))
  ipcMain.handle('task:get', (_event, id: string) => taskService.getTask(id))
  ipcMain.handle('task:detail', (_event, id: string) => {
    const task = taskService.getTask(id)
    if (!task) return null
    const deps = taskService.getDependencies(id)
    const subtasks = taskService.getSubtasks(id)
    return { task, dependencies: deps, subtasks, body: task.body }
  })
  ipcMain.handle('task:create', (_event, input) => taskService.createTask(input))
  ipcMain.handle('task:update', (_event, id: string, input) => taskService.updateTask(id, input))
  ipcMain.handle('task:delete', (_event, id: string) => taskService.deleteTask(id))
  ipcMain.handle('task:subtasks', (_event, parentId: string) => taskService.getSubtasks(parentId))

  ipcMain.handle('phase:list', (_event, projectId: string) => taskService.findPhases(projectId))
  ipcMain.handle('phase:get', (_event, id: string) => taskService.getPhase(id))
  ipcMain.handle('phase:create', (_event, input) => taskService.createPhase(input))
  ipcMain.handle('phase:update', (_event, id: string, input) => taskService.updatePhase(id, input))
  ipcMain.handle('phase:delete', (_event, id: string, cascade?: boolean) => {
    if (cascade) {
      const tasks = taskService.findTasks({ phaseId: id })
      for (const t of tasks) taskService.deleteTask(t.id)
    }
    taskService.deletePhase(id)
    return { ok: true }
  })
  ipcMain.handle('phase:progress', (_event, phaseId: string) =>
    taskService.getPhaseProgress(phaseId)
  )

  ipcMain.handle('task:pinned', () => taskService.getPinnedTasks())
  ipcMain.handle('task:due', (_event, date: string) => taskService.getDueTasks(date))

  ipcMain.handle('session:list', (_event, projectId: string) => taskService.findSessions(projectId))
  ipcMain.handle('session:get', (_event, id: string) => taskService.getSession(id))
  ipcMain.handle('session:delete', (_event, id: string) => {
    taskService.deleteSession(id)
    return { ok: true }
  })
  ipcMain.handle('conversation:list', (_event, projectId: string, status?: string) =>
    taskService.findConversations(
      projectId,
      status as Parameters<typeof taskService.findConversations>[1]
    )
  )
  ipcMain.handle('conversation:read', (_event, id: string) => {
    const conv = taskService.getConversation(id)
    if (!conv) return null
    const messages = taskService.getConversationMessages(id)
    const actions = taskService.getConversationActions(id)
    return { ...conv, messages, actions }
  })
  ipcMain.handle('conversation:delete', (_event, id: string) => {
    taskService.deleteConversation(id)
    return { ok: true }
  })

  // ── Inbox ───────────────────────────────────────────────────────────────────
  ipcMain.handle(
    'inbox:list',
    (_event, filter?: { projectId?: string | null; status?: string }) => {
      const f: Parameters<typeof taskService.findInbox>[0] = {}
      if (filter?.projectId !== undefined) f.projectId = filter.projectId
      if (filter?.status) f.status = filter.status as Parameters<typeof taskService.findInbox>[0]['status']
      return taskService.findInbox(f)
    }
  )
  ipcMain.handle('inbox:get', (_event, id: string) => {
    const item = taskService.getInbox(id)
    if (!item) return null
    const conversations = taskService.findConversationsByLink('inbox', id).map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      decisionSummary: c.decisionSummary,
      messages: taskService.getConversationMessages(c.id)
    }))
    return { item, conversations }
  })
  ipcMain.handle('inbox:add', (_event, input: { projectId: string; content: string }) =>
    taskService.createInbox({
      projectId: input.projectId,
      content: input.content
    })
  )
  ipcMain.handle(
    'inbox:update',
    (_event, id: string, content: string): { ok: boolean; error?: string; item?: unknown } => {
      const item = taskService.getInbox(id)
      if (!item) return { ok: false, error: 'not found' }
      if (item.status === 'converted' || item.status === 'archived') {
        return { ok: false, error: `status is ${item.status} — content locked` }
      }
      const updated = taskService.updateInbox(id, { content })
      return { ok: true, item: updated }
    }
  )
  ipcMain.handle(
    'inbox:research',
    (
      _event,
      id: string,
      researcher = 'Claude'
    ): { ok: boolean; error?: string; conversationId?: string; status?: string } => {
      const item = taskService.getInbox(id)
      if (!item) return { ok: false, error: 'not found' }
      if (item.status !== 'raw') return { ok: false, error: `status is ${item.status}, not raw` }
      const existing = taskService.findConversationsByLink('inbox', id)
      if (existing.length > 0) {
        return { ok: true, conversationId: existing[0].id, status: 'researching' }
      }
      const projectId = item.projectId ?? 'global'
      const conv = taskService.createConversation({
        projectId,
        title: `Research: ${item.content.slice(0, 80)}`,
        createdBy: researcher,
        status: 'open',
        participants: [
          { name: 'Butter', type: 'human' },
          { name: researcher, type: 'agent' }
        ]
      })
      taskService.linkConversation(conv.id, 'inbox', id)
      taskService.updateInbox(id, { status: 'researching' })
      return { ok: true, conversationId: conv.id, status: 'researching' }
    }
  )
  ipcMain.handle(
    'inbox:ready',
    (_event, id: string): { ok: boolean; error?: string; item?: unknown } => {
      const item = taskService.getInbox(id)
      if (!item) return { ok: false, error: 'not found' }
      if (item.status !== 'researching') {
        return { ok: false, error: `status is ${item.status}, not researching` }
      }
      const updated = taskService.updateInbox(id, { status: 'ready' })
      return { ok: true, item: updated }
    }
  )
  ipcMain.handle('inbox:archive', (_event, id: string, reason?: string) => {
    const item = taskService.getInbox(id)
    if (!item) return null
    taskService.updateInbox(id, { status: 'archived' })
    const convs = taskService.findConversationsByLink('inbox', id)
    for (const c of convs) {
      if (c.status !== 'closed') {
        taskService.updateConversation(c.id, {
          status: 'closed',
          decisionSummary: reason ? `Archived: ${reason}` : 'Archived',
          closedAt: new Date().toISOString()
        })
      }
    }
    return taskService.getInbox(id)
  })
  ipcMain.handle(
    'inbox:convert',
    (
      _event,
      id: string,
      taskInput: {
        title: string
        priority?: 'critical' | 'high' | 'medium' | 'low'
        labels?: string[]
        body?: string
      }
    ) => {
      const item = taskService.getInbox(id)
      if (!item) return { ok: false, error: 'not found' }
      if (!item.projectId) return { ok: false, error: 'inbox item has no projectId' }
      if (item.status === 'converted' || item.status === 'archived') {
        return { ok: false, error: `status is ${item.status}` }
      }
      const task = taskService.createTask({
        projectId: item.projectId,
        title: taskInput.title,
        priority: taskInput.priority,
        labels: taskInput.labels,
        status: 'TODO'
      })
      if (taskInput.body) taskService.updateTask(task.id, { body: taskInput.body })
      taskService.updateInbox(id, { status: 'converted', linkedTaskId: task.id })
      const convs = taskService.findConversationsByLink('inbox', id)
      for (const c of convs) {
        if (c.status !== 'closed') {
          taskService.updateConversation(c.id, {
            status: 'closed',
            decisionSummary: `Converted to ${task.id}: ${taskInput.title}`,
            closedAt: new Date().toISOString()
          })
        }
      }
      return { ok: true, taskId: task.id, task: taskService.getTask(task.id) }
    }
  )
  ipcMain.handle('inbox:delete', (_event, id: string) => {
    const item = taskService.getInbox(id)
    if (!item) return { ok: false, error: 'not found' }
    if (item.status !== 'raw' && item.status !== 'archived') {
      return { ok: false, error: `status is ${item.status}` }
    }
    taskService.deleteInbox(id)
    return { ok: true }
  })

  // ── Vault file browser IPC (Phase B) ───────────────────────────────────────
  const vaultService = new VaultService()

  ipcMain.handle('vault:tree', (_event, rootPath: string) => {
    return vaultService.readTree(rootPath)
  })

  ipcMain.handle('vault:read', (_event, filePath: string) => {
    return vaultService.readFile(filePath)
  })

  ipcMain.handle('vault:search', (_event, query: string, rootPath: string) => {
    return vaultService.search(query, rootPath)
  })

  ipcMain.handle('vault:resolve', (_event, wikilink: string, rootPath: string) => {
    return vaultService.resolveWikilink(wikilink, rootPath)
  })

  ipcMain.handle('vault:write', (_event, filePath: string, content: string) => {
    vaultService.writeFile(filePath, content)
    return { ok: true }
  })

  ipcMain.handle('vault:delete', (_event, filePath: string) => {
    vaultService.deleteFile(filePath)
    return { ok: true }
  })

  ipcMain.handle('vault:contentRoot', () => {
    return config.contentRoot
  })

  ipcMain.handle('vault:daily:run', (event) => {
    const vaultPath = config.contentRoot
    if (!vaultPath) return { ok: false, error: 'No contentRoot configured' }

    const proc = spawnProcess('claude', ['--print', '/daily'], {
      cwd: vaultPath,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env as { [key: string]: string }
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) event.sender.send('vault:daily:chunk', chunk.toString())
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      if (!event.sender.isDestroyed()) event.sender.send('vault:daily:chunk', chunk.toString())
    })
    proc.on('close', (code) => {
      if (!event.sender.isDestroyed()) event.sender.send('vault:daily:done', code ?? 0)
    })

    return { ok: true }
  })

  // MCP auto-register IPC
  ipcMain.handle('mcp:register-status', () => getMcpRegisterStatus())
  ipcMain.handle('mcp:unregister', () => unregisterMcp())

  // Pipeline IPC — approval UI bridge (TASK-543)
  registerPipelineIpc({
    taskService,
    artifactsConfig: { dataDir: dirname(dbPath) }
  })

  createWindow()

  // Auto-register choda-tasks MCP in ~/.claude.json if path changed / absent.
  // Silent no-op if user has no .claude.json.
  try {
    ensureMcpRegistered()
  } catch (err) {
    console.error('[mcp-register] Unexpected error:', err)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  // Graceful shutdown: send SIGINT first, wait, then force kill
  const pending: Array<Promise<void>> = []

  for (const [, session] of sessions.entries()) {
    pending.push(
      new Promise<void>((resolve) => {
        try {
          // Send Ctrl+C (SIGINT equivalent)
          session.write('\x03')
          const timeout = setTimeout(() => {
            try {
              session.kill()
            } catch {
              /* ignore */
            }
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
