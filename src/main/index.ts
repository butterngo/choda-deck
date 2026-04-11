import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import * as pty from 'node-pty'
import icon from '../../resources/icon.png?asset'

const is = {
  get dev(): boolean {
    return !app.isPackaged
  }
}

// Hardcoded spike config — first project only, to validate PTY + claude + xterm.js pipeline.
// This will be replaced by a real config loader once the spike passes.
const SPIKE_PROJECT = {
  id: 'workflow-engine',
  cwd: 'C:\\dev\\test\\workflow-engine',
  shell: process.platform === 'win32' ? 'claude.cmd' : 'claude'
}

// Map of session id -> running pty process
const sessions = new Map<string, pty.IPty>()

function createPtySession(id: string, cwd: string, cols: number, rows: number, webContents: Electron.WebContents): void {
  if (sessions.has(id)) {
    // Already exists — don't respawn
    return
  }

  const shellCmd = SPIKE_PROJECT.shell
  const ptyProcess = pty.spawn(shellCmd, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as { [key: string]: string }
  })

  ptyProcess.onData((data) => {
    webContents.send(`pty:data:${id}`, data)
  })

  ptyProcess.onExit(({ exitCode }) => {
    webContents.send(`pty:exit:${id}`, exitCode)
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

  // Expose spike project config to renderer
  ipcMain.handle('spike:project', () => SPIKE_PROJECT)

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
