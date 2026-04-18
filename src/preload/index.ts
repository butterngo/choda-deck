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

// Custom APIs for renderer — PTY bridge for xterm.js
const api = {
  pty: {
    spawn: (
      id: string,
      cwd: string,
      cols: number,
      rows: number
    ): Promise<{ ok: boolean; id: string }> => ipcRenderer.invoke('pty:spawn', id, cwd, cols, rows),
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
    add: (
      projectId: string,
      name: string,
      workspaceId: string,
      workspaceLabel: string,
      cwd: string
    ): Promise<{ ok: boolean; error?: string; project?: ProjectConfig }> =>
      ipcRenderer.invoke('project:add', projectId, name, workspaceId, workspaceLabel, cwd),
    remove: (projectId: string, workspaceId?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('project:remove', projectId, workspaceId)
  },
  task: {
    list: (filter: Record<string, unknown>): Promise<unknown[]> =>
      ipcRenderer.invoke('task:list', filter),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('task:get', id),
    detail: (id: string): Promise<unknown> => ipcRenderer.invoke('task:detail', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('task:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('task:update', id, input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('task:delete', id),
    subtasks: (parentId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('task:subtasks', parentId),
    pinned: (): Promise<unknown[]> => ipcRenderer.invoke('task:pinned'),
    due: (date: string): Promise<unknown[]> => ipcRenderer.invoke('task:due', date),
    refresh: (): Promise<{ imported: number; skipped: number; errors: string[] }> =>
      ipcRenderer.invoke('task:refresh'),
    import: (
      statusMap?: Record<string, string>
    ): Promise<{
      tasks: number
      phases: number
      documents: number
      skipped: number
      errors: string[]
    }> => ipcRenderer.invoke('vault:import', statusMap),
    onChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('task:changed', listener)
      return () => ipcRenderer.removeListener('task:changed', listener)
    }
  },
  phase: {
    list: (projectId: string): Promise<unknown[]> => ipcRenderer.invoke('phase:list', projectId),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('phase:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('phase:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('phase:update', id, input),
    delete: (id: string, cascade?: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('phase:delete', id, cascade),
    progress: (
      phaseId: string
    ): Promise<{
      total: number
      done: number
      inProgress: number
      status: string
      percent: number
    }> => ipcRenderer.invoke('phase:progress', phaseId)
  },
  feature: {
    list: (projectId: string): Promise<unknown[]> => ipcRenderer.invoke('feature:list', projectId),
    listByPhase: (phaseId: string): Promise<unknown[]> =>
      ipcRenderer.invoke('feature:listByPhase', phaseId),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('feature:get', id),
    create: (input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('feature:create', input),
    update: (id: string, input: Record<string, unknown>): Promise<unknown> =>
      ipcRenderer.invoke('feature:update', id, input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('feature:delete', id),
    progress: (
      featureId: string
    ): Promise<{
      total: number
      done: number
      inProgress: number
      status: string
      percent: number
    }> => ipcRenderer.invoke('feature:progress', featureId)
  },
  session: {
    list: (projectId: string): Promise<unknown[]> => ipcRenderer.invoke('session:list', projectId),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('session:get', id),
    delete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('session:delete', id)
  },
  conversation: {
    list: (projectId: string, status?: string): Promise<unknown[]> =>
      ipcRenderer.invoke('conversation:list', projectId, status),
    read: (id: string): Promise<unknown> => ipcRenderer.invoke('conversation:read', id),
    delete: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('conversation:delete', id)
  },
  inbox: {
    list: (filter?: { projectId?: string | null; status?: string }): Promise<unknown[]> =>
      ipcRenderer.invoke('inbox:list', filter),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke('inbox:get', id),
    add: (input: { projectId?: string | null; content: string }): Promise<unknown> =>
      ipcRenderer.invoke('inbox:add', input),
    update: (
      id: string,
      content: string
    ): Promise<{ ok: boolean; error?: string; item?: unknown }> =>
      ipcRenderer.invoke('inbox:update', id, content),
    research: (
      id: string,
      researcher?: string
    ): Promise<{ ok: boolean; error?: string; conversationId?: string; status?: string }> =>
      ipcRenderer.invoke('inbox:research', id, researcher),
    ready: (id: string): Promise<{ ok: boolean; error?: string; item?: unknown }> =>
      ipcRenderer.invoke('inbox:ready', id),
    archive: (id: string, reason?: string): Promise<unknown> =>
      ipcRenderer.invoke('inbox:archive', id, reason),
    convert: (
      id: string,
      taskInput: {
        title: string
        priority?: 'critical' | 'high' | 'medium' | 'low'
        labels?: string[]
        body?: string
      }
    ): Promise<{ ok: boolean; taskId?: string; error?: string }> =>
      ipcRenderer.invoke('inbox:convert', id, taskInput),
    delete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('inbox:delete', id)
  },
  backup: {
    list: (): Promise<Array<{ filename: string; date: string; size: number; mtimeMs: number }>> =>
      ipcRenderer.invoke('backups:list'),
    createNow: (): Promise<{
      ok: boolean
      backup?: { filename: string; date: string; size: number; mtimeMs: number }
      error?: string
    }> => ipcRenderer.invoke('backups:create-now'),
    restore: (filename: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('backups:restore', filename)
  },
  vault: {
    tree: (
      rootPath: string
    ): Promise<
      Array<{ name: string; path: string; type: 'file' | 'directory'; children?: unknown[] }>
    > => ipcRenderer.invoke('vault:tree', rootPath),
    read: (filePath: string): Promise<{ content: string; size: number; mtime: string }> =>
      ipcRenderer.invoke('vault:read', filePath),
    search: (
      query: string,
      rootPath: string
    ): Promise<
      Array<{ path: string; name: string; matches: Array<{ line: number; text: string }> }>
    > => ipcRenderer.invoke('vault:search', query, rootPath),
    resolve: (wikilink: string, rootPath: string): Promise<string | null> =>
      ipcRenderer.invoke('vault:resolve', wikilink, rootPath),
    write: (filePath: string, content: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('vault:write', filePath, content),
    delete: (filePath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('vault:delete', filePath),
    contentRoot: (): Promise<string> => ipcRenderer.invoke('vault:contentRoot'),
    daily: {
      run: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('vault:daily:run'),
      onChunk: (callback: (data: string) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, data: string): void => callback(data)
        ipcRenderer.on('vault:daily:chunk', listener)
        return () => ipcRenderer.removeListener('vault:daily:chunk', listener)
      },
      onDone: (callback: (exitCode: number) => void): (() => void) => {
        const listener = (_event: IpcRendererEvent, code: number): void => callback(code)
        ipcRenderer.on('vault:daily:done', listener)
        return () => ipcRenderer.removeListener('vault:daily:done', listener)
      }
    }
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
