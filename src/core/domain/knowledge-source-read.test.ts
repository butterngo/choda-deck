// TASK-1785 — provenance must not pay for staleness it never reads.
//
// The defect this pins: GET /tasks/:id took ~15 s because collectAdrs read all
// 44 decision entries through getKnowledge, and getKnowledge runs a `git log`
// subprocess per ref to answer "has this drifted". Provenance only wants the
// body text.
//
// A timing assertion would be the obvious test and the wrong one — it passes or
// fails on how loaded the machine is. What is actually load-bearing is that the
// cheap path never reaches git at all, so the git port is counted instead. That
// discriminates: revert collectAdrs to getKnowledge and the count goes up, on
// a fast machine and a slow one alike.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { KnowledgeService } from './knowledge-service'
import type { GitOps } from './knowledge-git'

const ADR = `---
type: decision
title: "ADR-999: a decision with refs"
projectId: p1
scope: project
refs:
  - path: src/a.ts
    commitSha: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  - path: src/b.ts
    commitSha: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
createdAt: 2026-08-25
lastVerifiedAt: 2026-08-25
---

# ADR-999

This one mentions TASK-1767 in its prose, the way 38 of 39 real ADRs do.
`

let root: string
let filePath: string
let gitCalls: string[]

function countingGit(): GitOps {
  return {
    getHeadSha: () => 'head',
    countCommitsSince: (_cwd: string, sha: string, p: string) => {
      gitCalls.push(`countCommitsSince ${sha.slice(0, 4)} ${p}`)
      return 0
    },
    isAncestor: () => true,
    filesInCommit: () => [],
    commitsInWindow: () => []
  }
}

function serviceFor(): KnowledgeService {
  const row = {
    slug: 'ADR-999',
    projectId: 'p1',
    workspaceId: null,
    scope: 'project' as const,
    type: 'decision' as const,
    title: 'ADR-999',
    filePath,
    createdAt: '2026-08-25',
    lastVerifiedAt: '2026-08-25'
  }
  return new KnowledgeService({
    knowledge: {
      get: async (s: string) => (s === 'ADR-999' ? row : null),
      list: async () => [row]
    },
    projects: { get: async () => ({ id: 'p1', name: 'p1', cwd: root }) },
    git: countingGit(),
    contentRoot: root,
    now: () => new Date('2026-08-25T00:00:00Z')
  } as never)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-source-'))
  filePath = path.join(root, 'ADR-999.md')
  fs.writeFileSync(filePath, ADR)
  gitCalls = []
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('readKnowledgeSource', () => {
  it('returns the body without touching git', async () => {
    const svc = serviceFor()
    const src = await svc.readKnowledgeSource('ADR-999')
    expect(src?.body).toContain('TASK-1767')
    expect(gitCalls).toEqual([])
  })

  it('does not carry a staleness field at all, rather than an empty one', async () => {
    const svc = serviceFor()
    const src = (await svc.readKnowledgeSource('ADR-999')) as Record<string, unknown> | null
    // `staleness: []` would read as "nothing has drifted" — a claim this path
    // has not earned. Absence is the honest shape.
    expect(src).not.toHaveProperty('staleness')
    expect(src).not.toHaveProperty('isStale')
  })

  it('is null for an unknown slug, like getKnowledge', async () => {
    const svc = serviceFor()
    expect(await svc.readKnowledgeSource('nope')).toBeNull()
  })
})

describe('getKnowledge — the control', () => {
  it('DOES reach git, once per ref, and still reports staleness', async () => {
    // Without this the assertion above proves nothing: a build where git was
    // never wired at all would pass "readKnowledgeSource makes no git calls".
    const svc = serviceFor()
    const entry = await svc.getKnowledge('ADR-999')
    expect(entry?.staleness).toHaveLength(2)
    expect(gitCalls).toHaveLength(2)
  })

  it('returns the same body and frontmatter as the cheap read', async () => {
    const svc = serviceFor()
    const full = await svc.getKnowledge('ADR-999')
    const cheap = await svc.readKnowledgeSource('ADR-999')
    // The fast path must not be fast because it read less of the file.
    expect(cheap?.body).toBe(full?.body)
    expect(cheap?.frontmatter.title).toBe(full?.frontmatter.title)
    expect(cheap?.filePath).toBe(full?.filePath)
  })
})
