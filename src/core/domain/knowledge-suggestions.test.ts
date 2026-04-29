import { describe, it, expect } from 'vitest'
import {
  collectFilesByCommit,
  deriveTitle,
  isKnowledgeWorthy,
  parseCommitSha,
  suggestKnowledge
} from './knowledge-suggestions'
import type { CommitFilesGit } from './knowledge-suggestions'

describe('isKnowledgeWorthy', () => {
  it('keeps decisions with keyword regardless of length', () => {
    expect(isKnowledgeWorthy('Chốt dùng better-sqlite3 thay sql.js')).toBe(true)
    expect(isKnowledgeWorthy('Decided convention: kebab-case')).toBe(true)
    expect(isKnowledgeWorthy('Architecture: split repo per domain')).toBe(true)
  })

  it('keeps long decisions even without keyword', () => {
    const longText = 'a'.repeat(100)
    expect(isKnowledgeWorthy(longText)).toBe(true)
  })

  it('drops short generic notes without keyword', () => {
    expect(isKnowledgeWorthy('Looks good')).toBe(false)
    expect(isKnowledgeWorthy('No issues')).toBe(false)
  })

  it('drops boilerplate even when long', () => {
    expect(isKnowledgeWorthy('Ran pnpm lint and pnpm test, both clean and finished without errors')).toBe(
      false
    )
    expect(isKnowledgeWorthy('Tests passed across all suites including new lifecycle coverage paths')).toBe(
      false
    )
    expect(isKnowledgeWorthy('Bumped @types/node to latest minor and re-ran the full pipeline')).toBe(
      false
    )
  })

  it('drops empty or whitespace-only input', () => {
    expect(isKnowledgeWorthy('')).toBe(false)
    expect(isKnowledgeWorthy('   ')).toBe(false)
  })
})

describe('deriveTitle', () => {
  it('returns first sentence trimmed', () => {
    expect(deriveTitle('Use better-sqlite3. Reason: persistence.')).toBe('Use better-sqlite3')
  })

  it('truncates long sentences with ellipsis', () => {
    const long = 'a'.repeat(120)
    const t = deriveTitle(long)
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t.endsWith('...')).toBe(true)
  })

  it('collapses internal whitespace', () => {
    expect(deriveTitle('decide   to   ship')).toBe('decide to ship')
  })
})

describe('parseCommitSha', () => {
  it('extracts short sha from leading position', () => {
    expect(parseCommitSha('d620417 feat(TASK-552): MCP workspace tools')).toBe('d620417')
  })

  it('extracts full sha', () => {
    const full = 'a'.repeat(40)
    expect(parseCommitSha(`${full} commit message`)).toBe(full)
  })

  it('returns null when no leading hex', () => {
    expect(parseCommitSha('not a sha')).toBe(null)
    expect(parseCommitSha('')).toBe(null)
  })
})

describe('suggestKnowledge', () => {
  it('emits one suggestion per knowledge-worthy decision', () => {
    const out = suggestKnowledge({
      decisions: [
        'Chốt dùng better-sqlite3',
        'Ran lint OK',
        'Pattern: facade composes repos per table'
      ]
    })
    expect(out).toHaveLength(2)
    expect(out[0].title).toBe('Chốt dùng better-sqlite3')
    expect(out[0].source).toBe('decision')
    expect(out[0].type).toBe('decision')
    expect(out[1].source).toBe('decision')
  })

  it('classifies looseEnds as type=learning', () => {
    const out = suggestKnowledge({
      looseEnds: ['Convention: always pass cwd via deps for testability']
    })
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('learning')
    expect(out[0].source).toBe('looseEnd')
  })

  it('attaches commit context to body', () => {
    const out = suggestKnowledge({
      decisions: ['Chốt KISS — không tách tool riêng'],
      commits: ['abc1234 feat: ship phase 3', 'def5678 test: cover heuristic']
    })
    expect(out[0].body).toContain('Chốt KISS')
    expect(out[0].body).toContain('## Commits')
    expect(out[0].body).toContain('abc1234')
    expect(out[0].body).toContain('def5678')
  })

  it('derives refs from filesByCommit map (union, sorted)', () => {
    const out = suggestKnowledge(
      {
        decisions: ['Architecture: split repos by table family'],
        commits: ['abc1234 feat', 'def5678 test']
      },
      {
        filesByCommit: new Map([
          ['abc1234', ['src/b.ts', 'src/a.ts']],
          ['def5678', ['src/a.ts', 'src/c.ts']]
        ])
      }
    )
    expect(out[0].refs).toEqual([
      { path: 'src/a.ts' },
      { path: 'src/b.ts' },
      { path: 'src/c.ts' }
    ])
  })

  it('returns empty array when no decisions or looseEnds', () => {
    expect(suggestKnowledge({})).toEqual([])
    expect(suggestKnowledge({ commits: ['abc1234 feat'] })).toEqual([])
  })

  it('skips body Commits section when no commits supplied', () => {
    const out = suggestKnowledge({ decisions: ['Decision: use single contentRoot'] })
    expect(out[0].body).not.toContain('## Commits')
  })
})

describe('collectFilesByCommit', () => {
  it('queries git per unique sha and dedupes', () => {
    const calls: string[] = []
    const git: CommitFilesGit = {
      filesInCommit(_cwd, sha) {
        calls.push(sha)
        return [`${sha}.ts`]
      }
    }
    const map = collectFilesByCommit('/repo', ['abc1234 feat', 'abc1234 feat dup', 'def5678 fix'], git)
    expect(calls).toEqual(['abc1234', 'def5678'])
    expect(map.get('abc1234')).toEqual(['abc1234.ts'])
    expect(map.get('def5678')).toEqual(['def5678.ts'])
  })

  it('returns empty map when cwd is empty', () => {
    const git: CommitFilesGit = {
      filesInCommit() {
        throw new Error('should not be called')
      }
    }
    expect(collectFilesByCommit('', ['abc1234 feat'], git).size).toBe(0)
  })

  it('swallows git errors per commit', () => {
    const git: CommitFilesGit = {
      filesInCommit() {
        throw new Error('git missing')
      }
    }
    const map = collectFilesByCommit('/repo', ['abc1234 feat'], git)
    expect(map.get('abc1234')).toEqual([])
  })
})
