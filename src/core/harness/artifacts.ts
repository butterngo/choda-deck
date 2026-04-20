import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannerPlan } from './plan-types'
import type { StageDiagnostics } from './stage-runner'

export interface ArtifactsConfig {
  dataDir: string
}

// Shape of <dataDir>/data/artifacts/<sessionId>/planner-failure.json. Written
// on every planner failure to give operators a self-contained debug bundle
// (the DB row carries the same diagnostics but a file is easier to grep).
export interface PlannerFailureArtifact {
  errorCode: string
  errorMessage: string
  sessionId: string
  stage: string
  iteration: number
  createdAt: string
  diagnostics: StageDiagnostics
}

export function getSessionArtifactsDir(cfg: ArtifactsConfig, sessionId: string): string {
  return join(cfg.dataDir, 'data', 'artifacts', sessionId)
}

export function writePlanArtifact(
  cfg: ArtifactsConfig,
  sessionId: string,
  planJson: unknown
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'plan.json')
  writeFileSync(filePath, JSON.stringify(planJson, null, 2), 'utf8')
  return filePath
}

// All PlannerPlan fields are optional — a malformed JSON that parses to the wrong
// shape still renders safely via the "—" fallbacks in PlanViewer.
export function readPlanArtifact(cfg: ArtifactsConfig, sessionId: string): PlannerPlan {
  const filePath = join(getSessionArtifactsDir(cfg, sessionId), 'plan.json')
  return JSON.parse(readFileSync(filePath, 'utf8')) as PlannerPlan
}

export function writePlannerFailureArtifact(
  cfg: ArtifactsConfig,
  sessionId: string,
  failure: PlannerFailureArtifact
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'planner-failure.json')
  writeFileSync(filePath, JSON.stringify(failure, null, 2), 'utf8')
  return filePath
}
