import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

export function readPlanArtifact(cfg: ArtifactsConfig, sessionId: string): unknown {
  const filePath = join(getSessionArtifactsDir(cfg, sessionId), 'plan.json')
  return JSON.parse(readFileSync(filePath, 'utf8'))
}
