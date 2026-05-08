import type { Task } from '../domain/task-types'

export interface CoderRunInput {
  task: Task
  worktreeCwd: string
  workspaceLabel: string
  systemPrompt: string
  maxBudgetUsd: number
}

export interface CoderRunOutput {
  filePath: string
  commitSha: string
  durationMs: number
  costUsd: number | null
  numTurns: number | null
}

export interface CoderDriver {
  readonly id: string
  spawnCoder(input: CoderRunInput): Promise<CoderRunOutput>
}

export class CoderDriverError extends Error {
  readonly stage: 'spawn' | 'parse' | 'verify' | 'commit'
  readonly stderr: string | null
  constructor(stage: CoderDriverError['stage'], message: string, stderr: string | null = null) {
    super(message)
    this.name = 'CoderDriverError'
    this.stage = stage
    this.stderr = stderr
  }
}
