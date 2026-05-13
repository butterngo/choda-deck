import { splitLines } from '../../utils/lines'

/**
 * Parse `## Acceptance` section of a task body and extract shell commands
 * to execute as the task's acceptance gate.
 *
 * Sources of commands (in order of appearance, preserved):
 *   1. Inline backticked `pnpm ...` / `node ...` commands (e.g. `- [ ] Lint: \`pnpm run lint\``)
 *   2. Fenced ```bash blocks — every non-empty, non-comment line
 *   3. Lines literally starting with `pnpm` or `node` after stripping list markers
 *
 * Section boundary: from the `## Acceptance` heading until the next `## ` or `# ` heading,
 * or end-of-body. Sub-headings (`### ...`) inside the section are kept.
 */
export function parseAcCommands(body: string): string[] {
  const section = extractAcSection(body)
  if (!section) return []

  const commands: string[] = []
  const bashBlockRe = /```bash\s*\n([\s\S]*?)```/g

  // 1. Fenced bash blocks — capture in source order alongside inline commands.
  // We walk the section once, splitting around bash blocks so all sources interleave by position.
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = bashBlockRe.exec(section)) !== null) {
    const before = section.slice(cursor, match.index)
    extractFromProse(before, commands)
    extractFromBashBlock(match[1], commands)
    cursor = match.index + match[0].length
  }
  extractFromProse(section.slice(cursor), commands)

  return commands
}

function extractAcSection(body: string): string | null {
  const lines = splitLines(body)
  const startIdx = lines.findIndex((l) => /^##\s+Acceptance\b/i.test(l))
  if (startIdx === -1) return null
  let endIdx = lines.length
  let inFence = false
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    // Stop at the next top-level (#) or section-level (##) heading — keep ###+ subsections.
    // Skip when inside a fenced block so `# install` shell comments aren't mistaken for headings.
    if (!inFence && /^#{1,2}\s+/.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx + 1, endIdx).join('\n')
}

function extractFromBashBlock(content: string, out: string[]): void {
  for (const raw of splitLines(content)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    out.push(line)
  }
}

function extractFromProse(prose: string, out: string[]): void {
  const inlineRe = /`((?:pnpm|node)\s[^`]+)`/g
  for (const line of splitLines(prose)) {
    let matched = false
    let m: RegExpExecArray | null
    inlineRe.lastIndex = 0
    while ((m = inlineRe.exec(line)) !== null) {
      out.push(m[1].trim())
      matched = true
    }
    if (matched) continue
    // Bare `pnpm ...` / `node ...` lines (after stripping list markers + checkbox).
    const stripped = line.replace(/^\s*(?:[-*]\s+(?:\[[xX\s]?\]\s+)?)?/, '')
    if (/^(pnpm|node)\s/.test(stripped)) out.push(stripped.trim())
  }
}
