import type { Task } from '../../tasks/task-types'
import type { PipelineStage } from './pipeline-state'
import type { PlannerPlan } from './plan-types'

export const MAX_PROMPT_CHARS = 30_000

export const PLANNER_ROLE = `You are analyzing a task to create an implementation plan.

- Read CLAUDE.md (auto-discovered from cwd) for project context.
- DO NOT write code.
- DO NOT modify any files.
- Focus on: files to touch, ordered steps, risks, dependencies.

OUTPUT CONTRACT (strict):

Your ENTIRE reply MUST be a single valid JSON object matching the schema below.
No prose before or after. No markdown fences. No explanations. Just JSON.

Schema:

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
}`

export const GENERATOR_ROLE = `You are implementing an already-approved plan.

- Read CLAUDE.md (auto-discovered from cwd) for project context.
- The approved plan is inlined below under "## Approved plan".
- Follow the plan EXACTLY. Do not add steps. Do not skip steps.
- If any step is ambiguous, unsafe, or conflicts with the codebase, STOP:
  - Do NOT modify any files.
  - Return status='stopped' with a one-sentence stopReason.
- Otherwise apply the plan using Edit/Write; use Bash only for git/npm/npx if the plan requires it.

OUTPUT CONTRACT (strict):

Your ENTIRE reply MUST be a single valid JSON object matching the schema below.
No prose before or after. No markdown fences. No explanations. Just JSON.

Schema:

{
  "status": "complete" | "stopped",
  "stopReason": "required when status=stopped; one sentence. null otherwise",
  "files": [
    { "path": "src/...", "action": "create | edit | delete" }
  ],
  "summary": "one-paragraph overview of what changed (empty string when stopped)",
  "diff": "markdown text. For each touched file, a fenced code block labelled 'diff' containing unified-diff hunks. Empty string when stopped."
}`

export type HarnessStage = Extract<PipelineStage, 'plan' | 'generate'>
export type PlannerStage = Extract<PipelineStage, 'plan'>

export const TOOL_ALLOWLIST: Record<HarnessStage, readonly string[]> = {
  plan: ['Read', 'Grep', 'Glob'],
  generate: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']
}

export const PREAPPROVED_TOOLS: Record<HarnessStage, readonly string[]> = {
  plan: [],
  generate: ['Bash(git *)', 'Bash(npm *)', 'Bash(npx *)']
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

export interface GeneratorInputs {
  task: Pick<Task, 'id' | 'title' | 'body'>
  plan: PlannerPlan
  rejectionFeedback?: string | null
}

export function buildGeneratorPrompt(inputs: GeneratorInputs): string {
  const { task, plan, rejectionFeedback } = inputs

  const bodySection = task.body?.trim() ? task.body.trim() : '(no body)'
  const planJson = JSON.stringify(plan, null, 2)
  const feedbackSection = rejectionFeedback?.trim()
    ? ['', '### Previous rejection feedback', rejectionFeedback.trim()]
    : []

  const prompt = [
    GENERATOR_ROLE,
    '---',
    `## Task ${task.id}: ${task.title}`,
    '',
    '### Task body',
    bodySection,
    '',
    '## Approved plan',
    '```json',
    planJson,
    '```',
    ...feedbackSection
  ].join('\n')

  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new PromptTooLargeError(prompt.length, MAX_PROMPT_CHARS)
  }
  return prompt
}
