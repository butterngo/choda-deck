import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

interface FilePointer {
  filePath: string
  startLine: number | undefined
  endLine: number | undefined
}

export type ResolveResult =
  | { ok: true; resolved: FilePointer[] }
  | { ok: false; errors: string[] }

export class PrewarmPointerResolveError extends Error {
  constructor(public readonly errors: string[]) {
    super(`prewarm pointer resolution failed:\n${errors.join('\n')}`)
    this.name = 'PrewarmPointerResolveError'
  }
}

function extractFilePointersSection(taskBody: string): string | null {
  const headingIdx = taskBody.indexOf('## File Pointers')
  if (headingIdx === -1) return null
  const afterHeading = taskBody.slice(headingIdx + '## File Pointers'.length)
  const nextHeadingMatch = afterHeading.match(/\n##\s/)
  const sectionEnd = nextHeadingMatch?.index ?? afterHeading.length
  return afterHeading.slice(0, sectionEnd)
}

function parseFilePointers(section: string): FilePointer[] {
  const pointers: FilePointer[] = []
  const lineRe = /^-\s+(?:`([^`]+)`|(\S+))/gm
  let m: RegExpExecArray | null
  while ((m = lineRe.exec(section)) !== null) {
    const raw = m[1] ?? m[2]
    if (!raw) continue
    const colonIdx = raw.lastIndexOf(':')
    if (colonIdx === -1) {
      pointers.push({ filePath: raw, startLine: undefined, endLine: undefined })
      continue
    }
    const afterColon = raw.slice(colonIdx + 1)
    const rangeMatch = afterColon.match(/^(\d+)(?:-(\d+))?$/)
    if (!rangeMatch) {
      pointers.push({ filePath: raw, startLine: undefined, endLine: undefined })
      continue
    }
    const filePath = raw.slice(0, colonIdx)
    const startLine = parseInt(rangeMatch[1], 10)
    const endLine = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : startLine
    pointers.push({ filePath, startLine, endLine })
  }
  return pointers
}

function extractSection(body: string, heading: string): string {
  const idx = body.indexOf(`## ${heading}`)
  if (idx === -1) return ''
  const after = body.slice(idx + `## ${heading}`.length)
  const nextMatch = after.match(/\n##\s/)
  return after.slice(0, nextMatch?.index ?? after.length)
}

export function findLineHint(filePath: string, body: string): [number, number] | null {
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(filePath)) {
      const window = lines.slice(i, i + 3).join('\n')
      const hit = window.match(/line\s+(\d+)(?:[-–]\s*(\d+))?/i)
      if (hit) {
        const start = parseInt(hit[1], 10)
        const end = hit[2] ? parseInt(hit[2], 10) : start
        return [start, end]
      }
    }
  }
  return null
}

export async function findSymbolLine(absPath: string, symbol: string): Promise<number | null> {
  let content: string
  try {
    content = await fsp.readFile(absPath, 'utf8')
  } catch {
    return null
  }
  const lines = content.split('\n')
  const symbolRe = new RegExp(`(function|class|const|export|interface|type)\\s+${symbol}\\b`)
  for (let i = 0; i < lines.length; i++) {
    if (symbolRe.test(lines[i])) {
      return i + 1
    }
  }
  return null
}

function extractSymbols(body: string): string[] {
  const combined = extractSection(body, 'Context') + '\n' + extractSection(body, 'Acceptance')
  const symbolSet = new Set<string>()
  const re = /`(\w+)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(combined)) !== null) {
    symbolSet.add(m[1])
  }
  return Array.from(symbolSet)
}

export async function resolvePointers(
  pointers: FilePointer[],
  cwd: string,
  taskBody: string
): Promise<ResolveResult> {
  const resolved: FilePointer[] = []
  const errors: string[] = []

  for (const pointer of pointers) {
    if (pointer.startLine !== undefined && pointer.endLine !== undefined) {
      resolved.push(pointer)
      continue
    }

    const absPath = path.resolve(cwd, pointer.filePath)

    // L1: non-existent path → new file, accept without range
    let fileExists = true
    try {
      await fsp.access(absPath)
    } catch {
      fileExists = false
    }
    if (!fileExists) {
      resolved.push(pointer)
      continue
    }

    // L2: line hint on the pointer's line + next 2 lines in the body
    const lineHint = findLineHint(pointer.filePath, taskBody)
    if (lineHint) {
      resolved.push({ ...pointer, startLine: lineHint[0], endLine: lineHint[1] })
      continue
    }

    // L3: symbol grep in ## Context / ## Acceptance
    const symbols = extractSymbols(taskBody)
    let found = false
    for (const symbol of symbols) {
      const lineNum = await findSymbolLine(absPath, symbol)
      if (lineNum !== null) {
        const content = await fsp.readFile(absPath, 'utf8')
        const totalLines = content.split('\n').length
        const start = Math.max(1, lineNum - 5)
        const end = Math.min(totalLines, lineNum + 5)
        resolved.push({ ...pointer, startLine: start, endLine: end })
        found = true
        break
      }
    }
    if (found) continue

    errors.push(`${pointer.filePath}: no range, no line hint, no matching symbol (L3 last attempted)`)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  return { ok: true, resolved }
}

export async function composePrewarmPrefix(taskBody: string, cwd: string): Promise<string> {
  const section = extractFilePointersSection(taskBody)
  if (!section) return ''

  const pointers = parseFilePointers(section)
  if (pointers.length === 0) return ''

  const result = await resolvePointers(pointers, cwd, taskBody)
  if (!result.ok) {
    throw new PrewarmPointerResolveError(result.errors)
  }

  const sections: string[] = []

  for (const pointer of result.resolved) {
    // L1 accept: new file, no section emitted
    if (pointer.startLine === undefined || pointer.endLine === undefined) {
      continue
    }

    const absPath = path.resolve(cwd, pointer.filePath)
    let fileContent: string
    try {
      fileContent = await fsp.readFile(absPath, 'utf8')
    } catch {
      continue
    }

    const lines = fileContent.split('\n')
    const excerpt = lines.slice(pointer.startLine - 1, pointer.endLine)
    sections.push(`## ${pointer.filePath}\n${excerpt.join('\n')}`)
  }

  if (sections.length === 0) return ''
  return `# Pre-warm\n\n${sections.join('\n\n')}`
}
