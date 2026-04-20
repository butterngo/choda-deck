import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannerPlan } from './plan-types'

export interface ArtifactsConfig {
  dataDir: string
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
