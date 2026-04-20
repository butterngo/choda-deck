import type { PlannerPlan } from '../../../core/harness/plan-types'
import type { PipelineState } from '../../../core/harness/pipeline-state'

export const FIXTURE_PLAN: PlannerPlan = {
  files: [
    {
      path: 'src/renderer/src/components/PlanViewer.tsx',
      action: 'create',
      why: 'Structured JSON renderer for plan.json artifacts'
    },
    {
      path: 'src/main/ipc/pipeline-ipc.ts',
      action: 'create',
      why: 'Bridge HarnessRunner events + methods to renderer via IPC'
    },
    {
      path: 'src/preload/index.ts',
      action: 'edit',
      why: 'Expose pipeline namespace through contextBridge'
    }
  ],
  steps: [
    {
      n: 1,
      title: 'Define PlannerPlan type in core/harness/',
      detail: 'Canonical schema shared by planner (write) and renderer (read).'
    },
    {
      n: 2,
      title: 'Build PlanViewer with 4 sub-panels',
      detail: 'Files / Steps / Risks / Dependencies — each renders gracefully when empty.'
    },
    {
      n: 3,
      title: 'Wire IPC bridge to HarnessRunner facade',
      detail: 'approve / reject / abort + plan.json read + stage-ready event stream.'
    }
  ],
  risks: [
    {
      what: 'Renderer crashes on malformed plan.json',
      mitigation: 'All schema fields optional; empty-state placeholder per panel.'
    },
    {
      what: 'Double-click approve triggers race in main',
      mitigation: 'Disable buttons while invoke is in-flight.'
    }
  ],
  dependencies: [
    {
      kind: 'task',
      ref: 'TASK-541',
      why: 'Produces plan.json artifact consumed by viewer.'
    },
    {
      kind: 'task',
      ref: 'TASK-542',
      why: 'HarnessRunner approve/reject/abort methods.'
    },
    {
      kind: 'file',
      ref: 'src/core/harness/prompts.ts',
      why: 'PLANNER_ROLE schema authoritative source.'
    }
  ]
}

export const FIXTURE_PIPELINE_STATE: PipelineState = {
  sessionId: 'SESSION-FIXTURE',
  projectId: 'choda-deck',
  taskId: 'TASK-543',
  stage: 'plan',
  stageStatus: 'ready',
  currentIteration: 0,
  needsEvaluator: false,
  startedAt: '2026-04-20T09:17:00.000Z'
}
