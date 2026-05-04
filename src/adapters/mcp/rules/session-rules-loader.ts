import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface SessionRules {
  sessionStart: string
  sessionCheckpoint: string
  sessionResume: string
  sessionEnd: string
}

const RULES_FILENAME = 'session-rules.md'

function rulesPath(): string {
  // Source tree (vitest): __dirname = src/adapters/mcp/rules/ → file co-located
  // Bundle: __dirname = dist/ → MD copied next to bundle by build:mcp
  return join(__dirname, RULES_FILENAME)
}

function parseSection(content: string, heading: string): string {
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'm')
  const head = content.match(headingRe)
  if (!head || head.index === undefined) return ''
  const startIdx = head.index + head[0].length
  const rest = content.slice(startIdx)
  const next = rest.match(/^##\s/m)
  const endIdx = next && next.index !== undefined ? startIdx + next.index : content.length
  return content.slice(startIdx, endIdx).trim()
}

const EMPTY_RULES: SessionRules = {
  sessionStart: '',
  sessionCheckpoint: '',
  sessionResume: '',
  sessionEnd: ''
}

export function loadSessionRules(path: string = rulesPath()): SessionRules {
  if (!existsSync(path)) {
    console.warn(`[session-rules] file not found at ${path} — returning empty rules`)
    return { ...EMPTY_RULES }
  }
  try {
    const content = readFileSync(path, 'utf-8')
    const sessionStart = parseSection(content, 'On session_start')
    const sessionCheckpoint = parseSection(content, 'On session_checkpoint')
    const sessionResume = parseSection(content, 'On session_resume')
    const sessionEnd = parseSection(content, 'On session_end')
    for (const [name, value] of [
      ['On session_start', sessionStart],
      ['On session_checkpoint', sessionCheckpoint],
      ['On session_resume', sessionResume],
      ['On session_end', sessionEnd]
    ] as const) {
      if (!value) console.warn(`[session-rules] "## ${name}" section missing in ${path}`)
    }
    return { sessionStart, sessionCheckpoint, sessionResume, sessionEnd }
  } catch (err) {
    console.error(`[session-rules] failed to read ${path}:`, err)
    return { ...EMPTY_RULES }
  }
}
