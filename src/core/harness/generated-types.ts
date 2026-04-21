// Canonical shape of the GENERATOR_ROLE JSON output (src/core/harness/prompts.ts),
// minus the transient `diff` field which HR splits out into diff.md.
// Shared by generator-stage (producer) and renderer DiffViewer (consumer).

import type { PlanFileAction } from './plan-types'

export type GeneratorStatus = 'complete' | 'stopped'

export interface GeneratorFile {
  path: string
  action: PlanFileAction
}

// Persisted shape of <artifacts>/<sid>/generated.json. The full Claude reply
// additionally carries a `diff` string that gets written to diff.md.
export interface GeneratorArtifact {
  status: GeneratorStatus
  stopReason: string | null
  files: GeneratorFile[]
  summary: string
}

// Claude's raw JSON reply — `diff` lives here before HR splits it out.
export interface GeneratorOutput extends GeneratorArtifact {
  diff: string
}
