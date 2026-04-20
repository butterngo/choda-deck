// Canonical shape of the PLANNER_ROLE JSON output (src/core/harness/prompts.ts).
// Shared by planner-stage (producer) and renderer PlanViewer (consumer).

export type PlanFileAction = 'create' | 'edit' | 'delete'
export type PlanDependencyKind = 'task' | 'file' | 'tool' | 'external'

export interface PlanFile {
  path: string
  action: PlanFileAction
  why: string
}

export interface PlanStep {
  n: number
  title: string
  detail: string
}

export interface PlanRisk {
  what: string
  mitigation: string
}

export interface PlanDependency {
  kind: PlanDependencyKind
  ref: string
  why: string
}

// All fields optional — PLANNER_ROLE may omit sections. UI renders "—" fallback.
export interface PlannerPlan {
  files?: PlanFile[]
  steps?: PlanStep[]
  risks?: PlanRisk[]
  dependencies?: PlanDependency[]
}
