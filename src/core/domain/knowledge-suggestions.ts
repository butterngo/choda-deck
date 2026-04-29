import type { SessionHandoff } from './task-types'
import type { GitOps } from './knowledge-git'

export type SuggestedKnowledgeType = 'decision' | 'learning' | 'postmortem'
export type SuggestedKnowledgeSource = 'decision' | 'looseEnd'

export interface SuggestedKnowledgeRef {
  path: string
}

export interface SuggestedKnowledge {
  type: SuggestedKnowledgeType
  title: string
  body: string
  refs: SuggestedKnowledgeRef[]
  source: SuggestedKnowledgeSource
}

const KEYWORDS: readonly string[] = [
  'chốt',
  'decide',
  'decision',
  'convention',
  'pattern',
  'architecture',
  'invariant',
  'tradeoff',
  'trade-off',
  'standard',
  'rule:'
]

const BLACKLIST_PATTERNS: readonly RegExp[] = [
  /^ran\b/i,
  /^fixed (typo|whitespace|formatting|lint)/i,
  /^lint\b/i,
  /^tests? passed/i,
  /^build (clean|ok|passed)/i,
  /^merged?\b/i,
  /^bumped?\b/i,
  /^pnpm /i,
  /^npm /i,
  /^prettier/i,
  /^renamed?\b/i
]

const MIN_LENGTH = 80
const TITLE_MAX = 80

export function isKnowledgeWorthy(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (BLACKLIST_PATTERNS.some((p) => p.test(t))) return false
  const lower = t.toLowerCase()
  if (KEYWORDS.some((kw) => lower.includes(kw))) return true
  return t.length > MIN_LENGTH
}

export function deriveTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, ' ')
  const firstSentence = collapsed.split(/[.!?\n]/)[0].trim()
  if (firstSentence.length <= TITLE_MAX) return firstSentence
  return firstSentence.slice(0, TITLE_MAX - 3).trimEnd() + '...'
}

export function parseCommitSha(line: string): string | null {
  const m = line.trim().match(/^([0-9a-f]{7,40})\b/i)
  return m ? m[1] : null
}

export interface SuggestKnowledgeDeps {
  filesByCommit: Map<string, string[]>
}

export function suggestKnowledge(
  handoff: SessionHandoff,
  deps: SuggestKnowledgeDeps = { filesByCommit: new Map() }
): SuggestedKnowledge[] {
  const commits = handoff.commits ?? []
  const refs = unionRefs(commits, deps.filesByCommit)
  const commitContext = commits.length > 0 ? commits.map((c) => `- ${c}`).join('\n') : ''

  const out: SuggestedKnowledge[] = []
  for (const decision of handoff.decisions ?? []) {
    if (!isKnowledgeWorthy(decision)) continue
    out.push(buildSuggestion(decision, 'decision', refs, commitContext))
  }
  for (const looseEnd of handoff.looseEnds ?? []) {
    if (!isKnowledgeWorthy(looseEnd)) continue
    out.push(buildSuggestion(looseEnd, 'looseEnd', refs, commitContext))
  }
  return out
}

function buildSuggestion(
  text: string,
  source: SuggestedKnowledgeSource,
  refs: SuggestedKnowledgeRef[],
  commitContext: string
): SuggestedKnowledge {
  const trimmed = text.trim()
  const body = commitContext ? `${trimmed}\n\n## Commits\n${commitContext}\n` : `${trimmed}\n`
  return {
    type: source === 'looseEnd' ? 'learning' : 'decision',
    title: deriveTitle(trimmed),
    body,
    refs,
    source
  }
}

function unionRefs(
  commitLines: string[],
  filesByCommit: Map<string, string[]>
): SuggestedKnowledgeRef[] {
  const set = new Set<string>()
  for (const line of commitLines) {
    const sha = parseCommitSha(line)
    if (!sha) continue
    const files = filesByCommit.get(sha) ?? []
    for (const f of files) set.add(f)
  }
  return [...set].sort().map((p) => ({ path: p }))
}

export interface CommitFilesGit extends Pick<GitOps, never> {
  filesInCommit(cwd: string, sha: string): string[]
}

export function collectFilesByCommit(
  cwd: string,
  commitLines: string[],
  git: CommitFilesGit
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!cwd) return map
  for (const line of commitLines) {
    const sha = parseCommitSha(line)
    if (!sha || map.has(sha)) continue
    try {
      map.set(sha, git.filesInCommit(cwd, sha))
    } catch {
      map.set(sha, [])
    }
  }
  return map
}
