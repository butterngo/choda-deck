import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

interface FilePointer {
  filePath: string
  startLine: number | undefined
  endLine: number | undefined
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

export async function composePrewarmPrefix(taskBody: string, cwd: string): Promise<string> {
  const section = extractFilePointersSection(taskBody)
  if (!section) return ''

  const pointers = parseFilePointers(section)
  if (pointers.length === 0) return ''

  const sections: string[] = []

  for (const pointer of pointers) {
    const absPath = path.resolve(cwd, pointer.filePath)
    let fileContent: string
    try {
      fileContent = await fsp.readFile(absPath, 'utf8')
    } catch {
      continue
    }

    const lines = fileContent.split('\n')
    const excerpt =
      pointer.startLine !== undefined && pointer.endLine !== undefined
        ? lines.slice(pointer.startLine - 1, pointer.endLine)
        : lines.slice(0, 20)

    sections.push(`## ${pointer.filePath}\n${excerpt.join('\n')}`)
  }

  if (sections.length === 0) return ''
  return `# Pre-warm\n\n${sections.join('\n\n')}`
}
