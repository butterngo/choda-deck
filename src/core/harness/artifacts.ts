import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannerPlan } from './plan-types'
import type { GeneratorArtifact } from './generated-types'
import type { StageDiagnostics } from './stage-runner'

export interface ArtifactsConfig {
  dataDir: string
}

// Shape of <dataDir>/data/artifacts/<sessionId>/planner-failure.json. Written
// on every planner failure to give operators a self-contained debug bundle
// (the DB row carries the same diagnostics but a file is easier to grep).
export interface StageFailureArtifact {
  errorCode: string
  errorMessage: string
  sessionId: string
  stage: string
  iteration: number
  createdAt: string
  diagnostics: StageDiagnostics
}

// Retained name for existing callers; the shape applies to any stage failure.
export type PlannerFailureArtifact = StageFailureArtifact

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
  failure: StageFailureArtifact
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'planner-failure.json')
  writeFileSync(filePath, JSON.stringify(failure, null, 2), 'utf8')
  return filePath
}

export function writeGeneratorArtifact(
  cfg: ArtifactsConfig,
  sessionId: string,
  generated: GeneratorArtifact
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'generated.json')
  writeFileSync(filePath, JSON.stringify(generated, null, 2), 'utf8')
  return filePath
}

export function readGeneratorArtifact(
  cfg: ArtifactsConfig,
  sessionId: string
): GeneratorArtifact {
  const filePath = join(getSessionArtifactsDir(cfg, sessionId), 'generated.json')
  return JSON.parse(readFileSync(filePath, 'utf8')) as GeneratorArtifact
}

export function writeDiffArtifact(
  cfg: ArtifactsConfig,
  sessionId: string,
  diffMd: string
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'diff.md')
  writeFileSync(filePath, diffMd, 'utf8')
  return filePath
}

export function readDiffArtifact(cfg: ArtifactsConfig, sessionId: string): string {
  const filePath = join(getSessionArtifactsDir(cfg, sessionId), 'diff.md')
  return readFileSync(filePath, 'utf8')
}

export function writeGeneratorFailureArtifact(
  cfg: ArtifactsConfig,
  sessionId: string,
  failure: StageFailureArtifact
): string {
  const dir = getSessionArtifactsDir(cfg, sessionId)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'generator-failure.json')
  writeFileSync(filePath, JSON.stringify(failure, null, 2), 'utf8')
  return filePath
}
