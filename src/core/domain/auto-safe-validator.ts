import type { Task } from './task-types'

export const AUTO_SAFE_LABEL = 'auto-safe'

export const AUTO_SAFE_SCOPE_HOURS_CEILING = 3

export interface AutoSafeValidationResult {
  valid: boolean
  errors: string[]
}

export function validateAutoSafeTask(task: Task): AutoSafeValidationResult {
  const errors: string[] = []
  const body = (task.body ?? '').trim()

  if (!body) {
    errors.push('Task body is empty — auto-safe requires AC, File Pointers, and Scope sections')
    return { valid: false, errors }
  }

  const ac = extractSection(body, /^acceptance(?:\s+criteria)?$/i)
  const filePointers = extractSection(body, /^file\s+pointers$/i)
  const scope = extractSection(body, /^scope$/i)

  if (!ac.trim()) {
    errors.push('Missing ## Acceptance (or ## Acceptance Criteria) section')
  } else if (!hasVerifiableShellCommand(ac)) {
    errors.push(
      '## Acceptance has no verifiable shell command (need `pnpm `, `node `, or a ```bash code block)'
    )
  }

  if (!filePointers.trim()) {
    errors.push('Missing ## File Pointers section')
  } else if (!hasConcretePath(filePointers)) {
    errors.push('## File Pointers has no concrete path (need at least one .ts/.md/.json/etc)')
  }

  if (!scope.trim()) {
    errors.push('Missing ## Scope section')
  } else {
    const upper = parseScopeHours(scope)
    if (upper === null) {
      errors.push('## Scope has no parseable hour estimate (e.g. "~2-3h", "2h", "1.5h")')
    } else if (upper > AUTO_SAFE_SCOPE_HOURS_CEILING) {
      errors.push(
        `## Scope estimate ${upper}h exceeds auto-safe ceiling of ${AUTO_SAFE_SCOPE_HOURS_CEILING}h`
      )
    }
  }

  if (mentionsBuildSensitive(body) && !hasSmokeStep(ac)) {
    errors.push(
      '## Acceptance must include a smoke step (body mentions build:mcp / build:cli / loader / asset copy)'
    )
  }

  return { valid: errors.length === 0, errors }
}

function extractSection(body: string, headingMatcher: RegExp): string {
  const lines = body.split(/\r?\n/)
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      if (inSection) break
      if (headingMatcher.test(headingMatch[1])) {
        inSection = true
        continue
      }
    }
    if (inSection) out.push(line)
  }
  return out.join('\n')
}

function hasVerifiableShellCommand(section: string): boolean {
  if (/(?:^|[\s`])(?:pnpm|node)\s+\S/m.test(section)) return true
  if (/```bash[\s\S]*?```/.test(section)) return true
  return false
}

function hasConcretePath(section: string): boolean {
  return /[\w./\\-]+\.(?:ts|tsx|js|mjs|cjs|mts|json|md|sh|yml|yaml)\b/.test(section)
}

function parseScopeHours(section: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?))?\s*h\b/i.exec(section)
  if (!match) return null
  return parseFloat(match[2] ?? match[1])
}

function mentionsBuildSensitive(body: string): boolean {
  return /build:(?:mcp|cli)|\bloader\b|asset\s+cop/i.test(body)
}

function hasSmokeStep(ac: string): boolean {
  return /\bsmoke\b/i.test(ac) || /pnpm\s+run\s+build:(?:mcp|cli)/i.test(ac)
}
