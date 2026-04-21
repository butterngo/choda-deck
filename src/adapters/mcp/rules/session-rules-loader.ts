import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface SessionRules {
  sessionStart: string
  sessionEnd: string
}

const RULES_FILENAME = 'session-rules.md'

function candidatePaths(): string[] {
  return [
    join(__dirname, RULES_FILENAME),
    join(__dirname, '..', 'src', 'tasks', 'rules', RULES_FILENAME),
    join(__dirname, '..', '..', 'src', 'tasks', 'rules', RULES_FILENAME)
  ]
}

function rulesPath(): string {
  for (const p of candidatePaths()) {
    if (existsSync(p)) return p
  }
  return candidatePaths()[0]
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

export function loadSessionRules(path: string = rulesPath()): SessionRules {
  if (!existsSync(path)) {
    console.warn(`[session-rules] file not found at ${path} — returning empty rules`)
    return { sessionStart: '', sessionEnd: '' }
  }
  try {
    const content = readFileSync(path, 'utf-8')
    const sessionStart = parseSection(content, 'On session_start')
    const sessionEnd = parseSection(content, 'On session_end')
    if (!sessionStart) {
      console.warn(`[session-rules] "## On session_start" section missing in ${path}`)
    }
    if (!sessionEnd) {
      console.warn(`[session-rules] "## On session_end" section missing in ${path}`)
    }
    return { sessionStart, sessionEnd }
  } catch (err) {
    console.error(`[session-rules] failed to read ${path}:`, err)
    return { sessionStart: '', sessionEnd: '' }
  }
}
