import type { KnowledgeFrontmatter, KnowledgeRef, KnowledgeType, KnowledgeScope } from './knowledge-types'
import { KNOWLEDGE_TYPES, KNOWLEDGE_SCOPES } from './knowledge-types'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

export class FrontmatterParseError extends Error {
  constructor(message: string) {
    super(`Frontmatter parse: ${message}`)
    this.name = 'FrontmatterParseError'
  }
}

export interface ParsedNote {
  frontmatter: KnowledgeFrontmatter
  body: string
}

export function parseFrontmatter(raw: string): ParsedNote {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) throw new FrontmatterParseError('missing --- delimiters at top of file')
  const fmText = m[1]
  const body = m[2] ?? ''

  const fm: Partial<KnowledgeFrontmatter> = { refs: [] }
  const lines = fmText.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }
    if (line.startsWith('refs:')) {
      const rest = line.slice('refs:'.length).trim()
      if (rest === '[]') {
        fm.refs = []
        i++
        continue
      }
      i++
      fm.refs = parseRefsBlock(lines, i)
      i = skipRefsBlock(lines, i)
      continue
    }
    const kv = line.match(/^([a-zA-Z]+):\s*(.*)$/)
    if (!kv) throw new FrontmatterParseError(`unrecognized line: ${line}`)
    const key = kv[1]
    const value = unquote(kv[2].trim())
    assignScalar(fm, key, value)
    i++
  }

  return { frontmatter: validate(fm), body }
}

function parseRefsBlock(lines: string[], startIdx: number): KnowledgeRef[] {
  const out: KnowledgeRef[] = []
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i]
    const itemMatch = line.match(/^\s*-\s*path:\s*(.+)$/)
    if (!itemMatch) break
    const ref: Partial<KnowledgeRef> = { path: unquote(itemMatch[1].trim()) }
    i++
    while (i < lines.length) {
      const cont = lines[i].match(/^\s{4,}([a-zA-Z]+):\s*(.+)$/)
      if (!cont) break
      if (cont[1] === 'commitSha') ref.commitSha = unquote(cont[2].trim())
      i++
    }
    if (!ref.path || !ref.commitSha) {
      throw new FrontmatterParseError('ref missing path or commitSha')
    }
    out.push({ path: ref.path, commitSha: ref.commitSha })
  }
  return out
}

function skipRefsBlock(lines: string[], startIdx: number): number {
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i]
    if (/^\s*-\s/.test(line) || /^\s{4,}\w/.test(line) || line.trim() === '') {
      i++
      continue
    }
    break
  }
  return i
}

function assignScalar(fm: Partial<KnowledgeFrontmatter>, key: string, value: string): void {
  switch (key) {
    case 'type':
      fm.type = value as KnowledgeType
      break
    case 'title':
      fm.title = value
      break
    case 'projectId':
      fm.projectId = value
      break
    case 'workspaceId':
      fm.workspaceId = value
      break
    case 'scope':
      fm.scope = value as KnowledgeScope
      break
    case 'createdAt':
      fm.createdAt = value
      break
    case 'lastVerifiedAt':
      fm.lastVerifiedAt = value
      break
    default:
      throw new FrontmatterParseError(`unknown key: ${key}`)
  }
}

function validate(fm: Partial<KnowledgeFrontmatter>): KnowledgeFrontmatter {
  if (!fm.type || !KNOWLEDGE_TYPES.includes(fm.type)) {
    throw new FrontmatterParseError(`invalid type: ${fm.type}`)
  }
  if (!fm.scope || !KNOWLEDGE_SCOPES.includes(fm.scope)) {
    throw new FrontmatterParseError(`invalid scope: ${fm.scope}`)
  }
  if (!fm.title) throw new FrontmatterParseError('missing title')
  if (!fm.projectId) throw new FrontmatterParseError('missing projectId')
  if (!fm.createdAt) throw new FrontmatterParseError('missing createdAt')
  if (!fm.lastVerifiedAt) throw new FrontmatterParseError('missing lastVerifiedAt')
  return {
    type: fm.type,
    title: fm.title,
    projectId: fm.projectId,
    workspaceId: fm.workspaceId,
    scope: fm.scope,
    refs: fm.refs ?? [],
    createdAt: fm.createdAt,
    lastVerifiedAt: fm.lastVerifiedAt
  }
}

export function serializeFrontmatter(fm: KnowledgeFrontmatter, body: string): string {
  const lines: string[] = ['---']
  lines.push(`type: ${fm.type}`)
  lines.push(`title: ${quoteIfNeeded(fm.title)}`)
  lines.push(`projectId: ${fm.projectId}`)
  if (fm.workspaceId) lines.push(`workspaceId: ${fm.workspaceId}`)
  lines.push(`scope: ${fm.scope}`)
  if (fm.refs.length === 0) {
    lines.push('refs: []')
  } else {
    lines.push('refs:')
    for (const r of fm.refs) {
      lines.push(`  - path: ${quoteIfNeeded(r.path)}`)
      lines.push(`    commitSha: ${r.commitSha}`)
    }
  }
  lines.push(`createdAt: ${fm.createdAt}`)
  lines.push(`lastVerifiedAt: ${fm.lastVerifiedAt}`)
  lines.push('---')
  const trimmedBody = body.replace(/^\r?\n+/, '')
  return lines.join('\n') + '\n\n' + trimmedBody + (trimmedBody.endsWith('\n') ? '' : '\n')
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return JSON.parse(v) as string
  }
  return v
}

function quoteIfNeeded(s: string): string {
  if (/[:#\[\]{}|>&*!%@`]/.test(s) || s !== s.trim()) return JSON.stringify(s)
  return s
}
