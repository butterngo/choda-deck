import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface WorkspaceConfig {
  id: string
  label: string
  cwd: string
  shell?: string
}

export interface ProjectConfig {
  id: string
  name: string
  workspaces: WorkspaceConfig[]
}

// Legacy compat
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
  project: {
    list: (): Promise<ProjectConfig[]> => ipcRenderer.invoke('project:list'),
    add: (projectId: string, name: string, workspaceId: string, workspaceLabel: string, cwd: string): Promise<{ ok: boolean; error?: string; project?: ProjectConfig }> =>
      ipcRenderer.invoke('project:add', projectId, name, workspaceId, workspaceLabel, cwd),
    remove: (projectId: string, workspaceId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('project:remove', projectId, workspaceId)
  },
  task: {
    list: (filter: Record<string, unknown>): Promise<unknown[]> =>
      ipcRenderer.invoke('task:list', filter),
    get: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('task:get', id),
    detail: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('task:detail', id),
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
      ipcRenderer.invoke('task:due', date),
    refresh: (): Promise<{ imported: number; skipped: number; errors: string[] }> =>
      ipcRenderer.invoke('task:refresh'),
    import: (statusMap?: Record<string, string>): Promise<{ tasks: number; phases: number; documents: number; skipped: number; errors: string[] }> =>
      ipcRenderer.invoke('vault:import', statusMap),
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('task:changed', listener)
      return () => ipcRenderer.removeListener('task:changed', listener)
    }
  },
  phase: {
    list: (projectId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('phase:list', projectId),
    get: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('phase:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('phase:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('phase:update', id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('phase:delete', id),
    progress: (phaseId: string): Promise<{ total: number; done: number; inProgress: number; status: string; percent: number }> =>
      ipcRenderer.invoke('phase:progress', phaseId)
  },
  feature: {
    list: (projectId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('feature:list', projectId),
    listByPhase: (phaseId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('feature:listByPhase', phaseId),
    get: (id: string): Promise<unknown> =>
      ipcRenderer.invoke('feature:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('feature:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('feature:update', id, input),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke('feature:delete', id),
    progress: (featureId: string): Promise<{ total: number; done: number; inProgress: number; status: string; percent: number }> =>
      ipcRenderer.invoke('feature:progress', featureId)
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
    progress: (epicId: string): Promise<{ total: number; done: number; inProgress: number; status: string; percent: number }> =>
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
