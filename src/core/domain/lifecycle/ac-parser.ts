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
 *
 * Each extracted command carries an `expectedExit` (default 0). For inline-backticked
 * commands, if the SAME LINE contains `\bexit\s+(\d+)\b` (case-insensitive), that integer
 * becomes the expected exit code. This lets AC bullets naturally assert non-zero exits, e.g.:
 *   - `node dist/cli.cjs run-queue --workspace nonexistent --dry-run` exit 3 (not-found path)
 * Bare-line commands and commands inside fenced ```bash blocks always have `expectedExit = 0`
 * (bare lines would otherwise swallow the hint into the cmd payload; bash-block prose context
 * is not visible inside the code fence).
 */

export interface AcCommand {
  cmd: string
  expectedExit: number
}

export function parseAcCommands(body: string): AcCommand[] {
  const section = extractAcSection(body)
  if (!section) return []

  const commands: AcCommand[] = []
  const bashBlockRe = /```bash\s*\n([\s\S]*?)```/g

  // Walk the section once, splitting around bash blocks so all sources interleave by position.
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

function extractFromBashBlock(content: string, out: AcCommand[]): void {
  for (const raw of splitLines(content)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    out.push({ cmd: line, expectedExit: 0 })
  }
}

function extractFromProse(prose: string, out: AcCommand[]): void {
  const inlineRe = /`((?:pnpm|node)\s[^`]+)`/g
  for (const line of splitLines(prose)) {
    let matched = false
    let m: RegExpExecArray | null
    inlineRe.lastIndex = 0
    while ((m = inlineRe.exec(line)) !== null) {
      // Hint applies only to inline-backticked commands — the backticks separate
      // the cmd payload from the surrounding prose where the hint lives.
      out.push({ cmd: m[1].trim(), expectedExit: parseExpectedExit(line) })
      matched = true
    }
    if (matched) continue
    // Bare `pnpm ...` / `node ...` lines (after stripping list markers + checkbox).
    // Bare lines do not support `exit N` hints — the cmd swallows the whole line
    // and adding hint detection would mix prose words into the executed command.
    const stripped = line.replace(/^\s*(?:[-*]\s+(?:\[[xX\s]?\]\s+)?)?/, '')
    if (/^(pnpm|node)\s/.test(stripped)) out.push({ cmd: stripped.trim(), expectedExit: 0 })
  }
}

function parseExpectedExit(line: string): number {
  const m = /\bexit\s+(\d+)\b/i.exec(line)
  if (!m) return 0
  return parseInt(m[1], 10)
}
