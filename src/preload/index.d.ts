import { ElectronAPI } from '@electron-toolkit/preload'

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

export interface ChodaApi {
  pty: {
    spawn: (
      id: string,
      cwd: string,
      cols: number,
      rows: number
    ) => Promise<{ ok: boolean; id: string }>
    input: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (id: string, callback: (data: string) => void) => () => void
    onExit: (id: string, callback: (exitCode: number) => void) => () => void
  }
  project: {
    list: () => Promise<ProjectConfig[]>
    add: (
      projectId: string,
      name: string,
      workspaceId: string,
      workspaceLabel: string,
      cwd: string
    ) => Promise<{ ok: boolean; error?: string; project?: ProjectConfig }>
    remove: (projectId: string, workspaceId?: string) => Promise<{ ok: boolean; error?: string }>
  }
  task: {
    list: (filter: Record<string, unknown>) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    detail: (id: string) => Promise<unknown>
    create: (input: Record<string, unknown>) => Promise<unknown>
    update: (id: string, input: Record<string, unknown>) => Promise<unknown>
    delete: (id: string) => Promise<void>
    subtasks: (parentId: string) => Promise<unknown[]>
    pinned: () => Promise<unknown[]>
    due: (date: string) => Promise<unknown[]>
    refresh: () => Promise<{ imported: number; skipped: number; errors: string[] }>
    import: (statusMap?: Record<string, string>) => Promise<{
      tasks: number
      phases: number
      documents: number
      skipped: number
      errors: string[]
    }>
    onChanged: (callback: () => void) => () => void
  }
  phase: {
    list: (projectId: string) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    create: (input: Record<string, unknown>) => Promise<unknown>
    update: (id: string, input: Record<string, unknown>) => Promise<unknown>
    delete: (id: string, cascade?: boolean) => Promise<{ ok: boolean }>
    progress: (phaseId: string) => Promise<{
      total: number
      done: number
      inProgress: number
      status: string
      percent: number
    }>
  }
  feature: {
    list: (projectId: string) => Promise<unknown[]>
    listByPhase: (phaseId: string) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    create: (input: Record<string, unknown>) => Promise<unknown>
    update: (id: string, input: Record<string, unknown>) => Promise<unknown>
    delete: (id: string) => Promise<void>
    progress: (featureId: string) => Promise<{
      total: number
      done: number
      inProgress: number
      status: string
      percent: number
    }>
  }
  session: {
    list: (projectId: string) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    delete: (id: string) => Promise<{ ok: boolean }>
  }
  conversation: {
    list: (projectId: string, status?: string) => Promise<unknown[]>
    read: (id: string) => Promise<unknown>
    delete: (id: string) => Promise<{ ok: boolean }>
  }
  vault: {
    tree: (
      rootPath: string
    ) => Promise<
      Array<{ name: string; path: string; type: 'file' | 'directory'; children?: unknown[] }>
    >
    read: (filePath: string) => Promise<{ content: string; size: number; mtime: string }>
    search: (
      query: string,
      rootPath: string
    ) => Promise<
      Array<{ path: string; name: string; matches: Array<{ line: number; text: string }> }>
    >
    resolve: (wikilink: string, rootPath: string) => Promise<string | null>
    write: (filePath: string, content: string) => Promise<{ ok: boolean }>
    delete: (filePath: string) => Promise<{ ok: boolean }>
    contentRoot: () => Promise<string>
    daily: {
      run: () => Promise<{ ok: boolean; error?: string }>
      onChunk: (callback: (data: string) => void) => () => void
      onDone: (callback: (exitCode: number) => void) => () => void
    }
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChodaApi
  }
}
