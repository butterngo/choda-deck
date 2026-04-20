import type { Task } from '../../tasks/task-types'
import type { PipelineStage } from './pipeline-state'

export const MAX_PROMPT_CHARS = 30_000

export const PLANNER_ROLE = `You are analyzing a task to create an implementation plan.

- Read CLAUDE.md (auto-discovered from cwd) for project context.
- Output two artifacts: plan.json (structured) and plan.md (human-readable).
- DO NOT write code.
- DO NOT modify any files.
- Focus on: files to touch, ordered steps, risks, dependencies.

plan.json schema:

\`\`\`json
{
  "files": [
    { "path": "src/...", "action": "create | edit | delete", "why": "one sentence" }
  ],
  "steps": [
    { "n": 1, "title": "imperative summary", "detail": "what to do, in plain language" }
  ],
  "risks": [
    { "what": "thing that could break", "mitigation": "how to handle it" }
  ],
  "dependencies": [
    { "kind": "task | file | tool | external", "ref": "TASK-xxx | path | name", "why": "..." }
  ]
}
\`\`\`

plan.md mirrors the same content as readable Markdown for Butter to review.`

export type PlannerStage = Extract<PipelineStage, 'plan'>

export const TOOL_ALLOWLIST: Record<PlannerStage, readonly string[]> = {
  plan: ['Read', 'Grep', 'Glob']
}

export class PromptTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number
  ) {
    super(`Planner prompt is ${size} chars, exceeds limit of ${limit}`)
    this.name = 'PromptTooLargeError'
  }
}

export interface PlannerInputs {
  task: Pick<Task, 'id' | 'title' | 'body'>
  acceptanceCriteria: readonly string[]
}

export function buildPlannerPrompt(inputs: PlannerInputs): string {
  const { task, acceptanceCriteria } = inputs

  const acSection =
    acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
      : '(none provided — infer from task body)'

  const bodySection = task.body?.trim() ? task.body.trim() : '(no body)'

  const prompt = [
    PLANNER_ROLE,
    '---',
    `## Task ${task.id}: ${task.title}`,
    '',
    '### Body',
    bodySection,
    '',
    '### Acceptance criteria',
    acSection
  ].join('\n')

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new PromptTooLargeError(prompt.length, MAX_PROMPT_CHARS)
  }
  return prompt
}
