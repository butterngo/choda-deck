import { BrowserWindow, Notification, ipcMain } from 'electron'
import type { SqliteTaskService } from '../../tasks/sqlite-task-service'
import { readPlanArtifact, type ArtifactsConfig } from '../../core/harness/artifacts'
import type { PlannerPlan } from '../../core/harness/plan-types'
import type { PipelineState } from '../../core/harness/pipeline-state'

const ANY_STAGE_CHANGE_CHANNEL = 'pipeline:any-stage-change'

// `plan.json` only exists once the planner produces it — if the renderer asks
// for it earlier (stageStatus='running'), `readFileSync` throws ENOENT. We let
// the renderer distinguish "pending" from "error" by inspecting stageStatus.

export interface PipelineIpcDeps {
  taskService: SqliteTaskService
  artifactsConfig: ArtifactsConfig
}

export function registerPipelineIpc(deps: PipelineIpcDeps): void {
  const { taskService, artifactsConfig } = deps
  const harness = taskService.getHarnessRunner()

  ipcMain.handle('pipeline:get-state', (_event, sessionId: string): PipelineState | null =>
    harness.getState(sessionId)
  )

  ipcMain.handle('pipeline:read-plan', (_event, sessionId: string): PlannerPlan =>
    readPlanArtifact(artifactsConfig, sessionId)
  )

  ipcMain.handle('pipeline:approve', (_event, sessionId: string): PipelineState =>
    harness.approveStage(sessionId)
  )

  ipcMain.handle(
    'pipeline:reject',
    (_event, sessionId: string, feedback: string): PipelineState =>
      harness.rejectStage(sessionId, feedback)
  )

  ipcMain.handle('pipeline:abort', (_event, sessionId: string): PipelineState =>
    harness.abort(sessionId)
  )

  // Fan-out stage changes: (a) per-session channel for PipelineView subscribers
  // that know their sessionId, (b) a generic channel so App.tsx can refresh its
  // "which project has an active pipeline" map without guessing session IDs.
  harness.onStageChange((state) => {
    const perSession = `pipeline:stage-change:${state.sessionId}`
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(perSession, state)
      win.webContents.send(ANY_STAGE_CHANGE_CHANNEL, state)
    }

    if (state.stageStatus === 'ready' && Notification.isSupported()) {
      const task = taskService.getTask(state.taskId)
      const title = task?.title ?? state.taskId
      new Notification({
        title: 'Plan ready for review',
        body: `${title} — stage ${state.stage}`
      }).show()
    }
  })
}
