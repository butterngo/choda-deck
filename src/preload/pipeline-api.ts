import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PipelineState } from '../core/harness/pipeline-state'
import type { PlannerPlan } from '../core/harness/plan-types'

export interface PipelineApi {
  getState: (sessionId: string) => Promise<PipelineState | null>
  readPlan: (sessionId: string) => Promise<PlannerPlan>
  approve: (sessionId: string) => Promise<PipelineState>
  reject: (sessionId: string, feedback: string) => Promise<PipelineState>
  abort: (sessionId: string) => Promise<PipelineState>
  onStageChange: (sessionId: string, callback: (state: PipelineState) => void) => () => void
  onAnyStageChange: (callback: (state: PipelineState) => void) => () => void
}

export const pipelineApi: PipelineApi = {
  getState: (sessionId) => ipcRenderer.invoke('pipeline:get-state', sessionId),
  readPlan: (sessionId) => ipcRenderer.invoke('pipeline:read-plan', sessionId),
  approve: (sessionId) => ipcRenderer.invoke('pipeline:approve', sessionId),
  reject: (sessionId, feedback) => ipcRenderer.invoke('pipeline:reject', sessionId, feedback),
  abort: (sessionId) => ipcRenderer.invoke('pipeline:abort', sessionId),
  onStageChange: (sessionId, callback) => {
    const channel = `pipeline:stage-change:${sessionId}`
    const listener = (_event: IpcRendererEvent, state: PipelineState): void => callback(state)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
  onAnyStageChange: (callback) => {
    const channel = 'pipeline:any-stage-change'
    const listener = (_event: IpcRendererEvent, state: PipelineState): void => callback(state)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  }
}
