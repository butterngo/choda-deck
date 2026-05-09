import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export interface McpRules {
  sessionStart: string
  sessionCheckpoint: string
  sessionResume: string
  sessionEnd: string
  conversationRead: string
}

const RULES_FILENAME = 'mcp-rules.md'

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

const EMPTY_RULES: McpRules = {
  sessionStart: '',
  sessionCheckpoint: '',
  sessionResume: '',
  sessionEnd: '',
  conversationRead: ''
}

export function loadMcpRules(path: string = rulesPath()): McpRules {
  if (!existsSync(path)) {
    console.warn(`[mcp-rules] file not found at ${path} — returning empty rules`)
    return { ...EMPTY_RULES }
  }
  try {
    const content = readFileSync(path, 'utf-8')
    const sessionStart = parseSection(content, 'On session_start')
    const sessionCheckpoint = parseSection(content, 'On session_checkpoint')
    const sessionResume = parseSection(content, 'On session_resume')
    const sessionEnd = parseSection(content, 'On session_end')
    const conversationRead = parseSection(content, 'On conversation_read')
    for (const [name, value] of [
      ['On session_start', sessionStart],
      ['On session_checkpoint', sessionCheckpoint],
      ['On session_resume', sessionResume],
      ['On session_end', sessionEnd],
      ['On conversation_read', conversationRead]
    ] as const) {
      if (!value) console.warn(`[mcp-rules] "## ${name}" section missing in ${path}`)
    }
    return { sessionStart, sessionCheckpoint, sessionResume, sessionEnd, conversationRead }
  } catch (err) {
    console.error(`[mcp-rules] failed to read ${path}:`, err)
    return { ...EMPTY_RULES }
  }
}
