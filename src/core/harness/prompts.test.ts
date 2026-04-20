import { describe, it, expect } from 'vitest'
import {
  buildPlannerPrompt,
  MAX_PROMPT_CHARS,
  PLANNER_ROLE,
  PromptTooLargeError,
  TOOL_ALLOWLIST
} from './prompts'
import { EVALUATOR_TRIGGER_KEYWORDS, shouldEnableEvaluator } from './evaluator-triggers'

describe('PLANNER_ROLE', () => {
  it('matches snapshot (regenerate intentionally on prompt change)', () => {
    expect(PLANNER_ROLE).toMatchInlineSnapshot(`
      "You are analyzing a task to create an implementation plan.

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

      plan.md mirrors the same content as readable Markdown for Butter to review."
    `)
  })

  it('forbids code-writing tools by content', () => {
    expect(PLANNER_ROLE).toMatch(/DO NOT write code/i)
    expect(PLANNER_ROLE).toMatch(/DO NOT modify any files/i)
  })
})

describe('TOOL_ALLOWLIST.plan', () => {
  it('contains only read-only tools', () => {
    expect(TOOL_ALLOWLIST.plan).toEqual(['Read', 'Grep', 'Glob'])
  })
})

describe('buildPlannerPrompt', () => {
  const baseTask = {
    id: 'TASK-100',
    title: 'Add foo to bar',
    body: '## Why\n\nFoo is missing.\n\n## Scope\n\nAdd foo.'
  }

  it('combines role + task header + body + AC into one string', () => {
    const out = buildPlannerPrompt({
      task: baseTask,
      acceptanceCriteria: ['Foo exists', 'Bar references foo']
    })
    expect(out).toContain(PLANNER_ROLE)
    expect(out).toContain('## Task TASK-100: Add foo to bar')
    expect(out).toContain('Foo is missing.')
    expect(out).toContain('1. Foo exists')
    expect(out).toContain('2. Bar references foo')
  })

  it('handles empty AC list with explicit marker', () => {
    const out = buildPlannerPrompt({ task: baseTask, acceptanceCriteria: [] })
    expect(out).toContain('(none provided — infer from task body)')
  })

  it('handles null body with explicit marker', () => {
    const out = buildPlannerPrompt({
      task: { id: 'TASK-101', title: 'Empty', body: null },
      acceptanceCriteria: ['One']
    })
    expect(out).toContain('(no body)')
  })

  it('produces output under MAX_PROMPT_CHARS for realistic input', () => {
    const out = buildPlannerPrompt({
      task: baseTask,
      acceptanceCriteria: ['Foo exists', 'Bar references foo']
    })
    expect(out.length).toBeLessThan(MAX_PROMPT_CHARS)
  })

  it('throws PromptTooLargeError when combined input exceeds the limit', () => {
    const huge = 'x'.repeat(MAX_PROMPT_CHARS)
    expect(() =>
      buildPlannerPrompt({
        task: { id: 'TASK-999', title: 'Large', body: huge },
        acceptanceCriteria: []
      })
    ).toThrow(PromptTooLargeError)
  })
})

describe('evaluator triggers', () => {
  it('exports a non-empty keyword list', () => {
    expect(EVALUATOR_TRIGGER_KEYWORDS.length).toBeGreaterThan(0)
  })

  it('matches a security-keyword task title (case-insensitive)', () => {
    expect(shouldEnableEvaluator('Add Authentication middleware', [])).toBe(true)
  })

  it('matches a keyword embedded in an AC line', () => {
    expect(shouldEnableEvaluator('Refactor module', ['Run schema migration before tests'])).toBe(
      true
    )
  })

  it('returns false when no trigger keyword is present', () => {
    expect(shouldEnableEvaluator('Rename helper function', ['rename complete'])).toBe(false)
  })
})
