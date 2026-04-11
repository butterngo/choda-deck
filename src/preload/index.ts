import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface SpikeProject {
  id: string
  cwd: string
  shell: string
}

// Custom APIs for renderer — PTY bridge for xterm.js
const api = {
  pty: {
    spawn: (id: string, cwd: string, cols: number, rows: number): Promise<{ ok: boolean; id: string }> =>
      ipcRenderer.invoke('pty:spawn', id, cwd, cols, rows),
    input: (id: string, data: string): void => {
      ipcRenderer.send('pty:input', id, data)
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send('pty:resize', id, cols, rows)
    },
    kill: (id: string): void => {
      ipcRenderer.send('pty:kill', id)
    },
    onData: (id: string, callback: (data: string) => void): (() => void) => {
      const channel = `pty:data:${id}`
      const listener = (_event: IpcRendererEvent, data: string): void => callback(data)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id: string, callback: (exitCode: number) => void): (() => void) => {
      const channel = `pty:exit:${id}`
      const listener = (_event: IpcRendererEvent, exitCode: number): void => callback(exitCode)
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  spike: {
    getProject: (): Promise<SpikeProject> => ipcRenderer.invoke('spike:project')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
