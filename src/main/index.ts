import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
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

// Map of session id -> running pty process
const sessions = new Map<string, pty.IPty>()

function createPtySession(id: string, cwd: string, cols: number, rows: number, webContents: Electron.WebContents): void {
  if (sessions.has(id)) {
    // Already exists — don't respawn
    return
  }

  const project = projects.find(p => p.id === id)
  const shellCmd = project ? project.shell : DEFAULT_SHELL
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

  // Load projects from config
  projects = loadProjects()

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

  // Legacy spike handlers (backwards compat)
  ipcMain.handle('spike:project', () => projects[0] || null)
  ipcMain.handle('spike:projects', () => projects)

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Clean up any running PTY sessions
  for (const session of sessions.values()) {
    try {
      session.kill()
    } catch {
      // Ignore errors on shutdown
    }
  }
  sessions.clear()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
