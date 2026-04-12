import { ElectronAPI } from '@electron-toolkit/preload'

export interface SpikeProject {
  id: string
  cwd: string
  shell: string
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
