import { ElectronAPI } from '@electron-toolkit/preload'

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

export interface ChodaApi {
  pty: {
    spawn: (id: string, cwd: string, cols: number, rows: number) => Promise<{ ok: boolean; id: string }>
    input: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => void
    onData: (id: string, callback: (data: string) => void) => () => void
    onExit: (id: string, callback: (exitCode: number) => void) => () => void
  }
  project: {
    list: () => Promise<SpikeProject[]>
    add: (id: string, cwd: string) => Promise<{ ok: boolean; error?: string; project?: SpikeProject }>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  plugin: {
    list: () => Promise<PluginEntry[]>
    add: (entry: PluginEntry) => Promise<{ ok: boolean; error?: string; plugin?: PluginEntry }>
    remove: (id: string) => Promise<{ ok: boolean; error?: string }>
    toggle: (id: string) => Promise<{ ok: boolean; error?: string; enabled?: boolean }>
    statuses: () => Promise<Array<{ id: string; enabled: boolean; status: string }>>
    restart: (id: string) => Promise<{ ok: boolean; error?: string }>
  }
  task: {
    list: (filter: Record<string, unknown>) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    create: (input: Record<string, unknown>) => Promise<unknown>
    update: (id: string, input: Record<string, unknown>) => Promise<unknown>
    delete: (id: string) => Promise<void>
    subtasks: (parentId: string) => Promise<unknown[]>
    pinned: () => Promise<unknown[]>
    due: (date: string) => Promise<unknown[]>
    refresh: () => Promise<{ imported: number; skipped: number; errors: string[] }>
    import: (vaultPath: string, statusMap?: Record<string, string>) => Promise<{ imported: number; skipped: number; errors: string[] }>
  }
  epic: {
    list: (projectId: string) => Promise<unknown[]>
    get: (id: string) => Promise<unknown>
    create: (input: Record<string, unknown>) => Promise<unknown>
    update: (id: string, input: Record<string, unknown>) => Promise<unknown>
    delete: (id: string) => Promise<void>
    progress: (epicId: string) => Promise<{ total: number; done: number }>
  }
  spike: {
    getProject: () => Promise<SpikeProject>
    getProjects: () => Promise<SpikeProject[]>
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: ChodaApi
  }
}
