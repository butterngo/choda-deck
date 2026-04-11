// Minimal Electron main — sanity check: does require('electron') work at all?
const { app, BrowserWindow } = require('electron')

console.log('[minimal] app =', typeof app)
console.log('[minimal] BrowserWindow =', typeof BrowserWindow)
console.log('[minimal] process.type =', process.type)

if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 400, height: 300 })
    win.loadURL('data:text/html,<h1>hello from electron</h1>')
    console.log('[minimal] window created')
  })
  app.on('window-all-closed', () => app.quit())
} else {
  console.error('[minimal] app is not a proper Electron App object')
  process.exit(1)
}
