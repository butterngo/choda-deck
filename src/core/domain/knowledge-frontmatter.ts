import type {
  EffortBand,
  FeatureStatus,
  KnowledgeFrontmatter,
  KnowledgeRef,
  KnowledgeStructured,
  KnowledgeType,
  KnowledgeScope
} from './knowledge-types'
import {
  EFFORT_BANDS,
  FEATURE_STATUSES,
  KNOWLEDGE_TYPES,
  KNOWLEDGE_SCOPES
} from './knowledge-types'

// TASK-988: structured frontmatter keys for the first-class graph types.
// Scalars round-trip as `key: value`; lists as a JSON array on one line
// (`realizesTasks: ["TASK-909","TASK-910"]`) — keeps the line-oriented parser
// simple and CRLF-safe.
const STRUCTURED_SCALAR_KEYS = ['anchorTaskId', 'effortBand', 'status', 'affectedFeatureId'] as const
const STRUCTURED_LIST_KEYS = ['realizesTasks', 'inWorkspaces'] as const

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
  const structured: KnowledgeStructured = {}
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
    const rawValue = kv[2].trim()
    if (assignStructured(structured, key, rawValue)) {
      i++
      continue
    }
    assignScalar(fm, key, unquote(rawValue))
    i++
  }

  return { frontmatter: validate(fm, structured), body }
}

// Returns true if the key is a known structured field (and assigns it).
function assignStructured(
  s: KnowledgeStructured,
  key: string,
  rawValue: string
): boolean {
  if ((STRUCTURED_SCALAR_KEYS as readonly string[]).includes(key)) {
    const value = unquote(rawValue)
    if (key === 'effortBand') s.effortBand = value as EffortBand
    else if (key === 'status') s.status = value as FeatureStatus
    else if (key === 'anchorTaskId') s.anchorTaskId = value
    else if (key === 'affectedFeatureId') s.affectedFeatureId = value
    return true
  }
  if ((STRUCTURED_LIST_KEYS as readonly string[]).includes(key)) {
    const list = parseInlineList(rawValue)
    if (key === 'realizesTasks') s.realizesTasks = list
    else if (key === 'inWorkspaces') s.inWorkspaces = list
    return true
  }
  return false
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim()
  if (trimmed === '[]' || trimmed === '') return []
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (Array.isArray(parsed)) return parsed.map((v) => String(v))
  } catch {
    /* fall through to comma-split */
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => unquote(v.trim()))
    .filter((v) => v.length > 0)
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

function validate(
  fm: Partial<KnowledgeFrontmatter>,
  structured: KnowledgeStructured
): KnowledgeFrontmatter {
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
  if (structured.effortBand && !EFFORT_BANDS.includes(structured.effortBand)) {
    throw new FrontmatterParseError(`invalid effortBand: ${structured.effortBand}`)
  }
  if (structured.status && !FEATURE_STATUSES.includes(structured.status)) {
    throw new FrontmatterParseError(`invalid status: ${structured.status}`)
  }
  const hasStructured = Object.values(structured).some((v) => v !== undefined)
  return {
    type: fm.type,
    title: fm.title,
    projectId: fm.projectId,
    workspaceId: fm.workspaceId,
    scope: fm.scope,
    refs: fm.refs ?? [],
    createdAt: fm.createdAt,
    lastVerifiedAt: fm.lastVerifiedAt,
    structured: hasStructured ? structured : undefined
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
  const s = fm.structured
  if (s) {
    if (s.anchorTaskId) lines.push(`anchorTaskId: ${s.anchorTaskId}`)
    if (s.realizesTasks && s.realizesTasks.length > 0) {
      lines.push(`realizesTasks: ${JSON.stringify(s.realizesTasks)}`)
    }
    if (s.inWorkspaces && s.inWorkspaces.length > 0) {
      lines.push(`inWorkspaces: ${JSON.stringify(s.inWorkspaces)}`)
    }
    if (s.effortBand) lines.push(`effortBand: ${s.effortBand}`)
    if (s.status) lines.push(`status: ${s.status}`)
    if (s.affectedFeatureId) lines.push(`affectedFeatureId: ${s.affectedFeatureId}`)
  }
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
