import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface SpikeProject {
  id: string
  cwd: string
  shell: string
}

export interface PluginEntry {
  id: string
  type: 'mcp'
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  enabled: boolean
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
  project: {
    list: (): Promise<SpikeProject[]> => ipcRenderer.invoke('project:list'),
    add: (id: string, cwd: string): Promise<{ ok: boolean; error?: string; project?: SpikeProject }> =>
      ipcRenderer.invoke('project:add', id, cwd),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('project:remove', id)
  },
  plugin: {
    list: (): Promise<PluginEntry[]> => ipcRenderer.invoke('plugin:list'),
    add: (entry: PluginEntry): Promise<{ ok: boolean; error?: string; plugin?: PluginEntry }> =>
      ipcRenderer.invoke('plugin:add', entry),
    remove: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('plugin:remove', id),
    toggle: (id: string): Promise<{ ok: boolean; error?: string; enabled?: boolean }> =>
      ipcRenderer.invoke('plugin:toggle', id),
    statuses: (): Promise<Array<{ id: string; enabled: boolean; status: string }>> =>
      ipcRenderer.invoke('plugin:statuses'),
    restart: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('plugin:restart', id)
  },
  task: {
    list: (filter: Record<string, unknown>): Promise<unknown[]> =>
      ipcRenderer.invoke('task:list', filter),
    get: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('task:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('task:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('task:update', id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('task:delete', id),
    subtasks: (parentId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('task:subtasks', parentId),
    pinned: (): Promise<unknown[]> =>
      ipcRenderer.invoke('task:pinned'),
    due: (date: string): Promise<unknown[]> =>
      ipcRenderer.invoke('task:due', date)
  },
  epic: {
    list: (projectId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('epic:list', projectId),
    get: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('epic:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('epic:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('epic:update', id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('epic:delete', id),
    progress: (epicId: string): Promise<{ total: number; done: number }> =>
      ipcRenderer.invoke('epic:progress', epicId)
  },
  spike: {
    getProject: (): Promise<SpikeProject> => ipcRenderer.invoke('spike:project'),
    getProjects: (): Promise<SpikeProject[]> => ipcRenderer.invoke('spike:projects')
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
