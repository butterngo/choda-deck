#!/usr/bin/env node
// One-shot: populate refs[] in ADR-018 frontmatter with current HEAD SHAs.
// Loose end of TASK-634 — ADR-018 was authored by hand with refs:[] (chicken-and-egg
// since knowledge_create did not exist yet). This script pins refs to the implementation
// files committed by TASK-634, so staleness banner becomes meaningful.
//
// Usage: node scripts/inject-adr-018-refs.mjs

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'

// Script lives in the task-636 worktree; modify the worktree's working copy
// of ADR-018 so the change can be committed on task-636 branch.
// Shared DB lives in main checkout (CHODA_DATA_DIR points there). DB sync
// happens post-merge via `knowledge_verify ADR-018-knowledge-layer`.
const WORKTREE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).slice(1), '..')
const ADR_PATH = path.join(WORKTREE_ROOT, 'docs', 'knowledge', 'ADR-018-knowledge-layer.md')
const TODAY = '2026-04-29'
const SLUG = 'ADR-018-knowledge-layer'

// Refs = the actual code-coupled files of the knowledge layer foundation.
// (Task body listed knowledge-create.ts/list.ts/... but the implementation
// shipped a single MCP adapter file + the domain service split. These are
// the real files to track.)
const REF_PATHS = [
  'src/adapters/mcp/mcp-tools/knowledge-tools.ts',
  'src/core/domain/interfaces/knowledge-operations.interface.ts',
  'src/core/domain/knowledge-frontmatter.ts',
  'src/core/domain/knowledge-git.ts',
  'src/core/domain/knowledge-service.ts',
  'src/core/domain/knowledge-types.ts',
  'src/core/domain/repositories/knowledge-repository.ts'
]

function getHeadSha() {
  return execSync('git rev-parse HEAD', { cwd: WORKTREE_ROOT, encoding: 'utf8' }).trim()
}

function quoteIfNeeded(s) {
  if (/[:#\[\]{}|>&*!%@`]/.test(s) || s !== s.trim()) return JSON.stringify(s)
  return s
}

function main() {
  if (!fs.existsSync(ADR_PATH)) {
    console.error(`ADR not found: ${ADR_PATH}`)
    process.exit(1)
  }
  for (const p of REF_PATHS) {
    const abs = path.join(WORKTREE_ROOT, p)
    if (!fs.existsSync(abs)) {
      console.error(`Ref file does not exist: ${p}`)
      process.exit(1)
    }
  }

  const sha = getHeadSha()
  console.log(`Pinning refs to HEAD = ${sha}`)

  const raw = fs.readFileSync(ADR_PATH, 'utf8')
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) {
    console.error('No frontmatter delimiter found')
    process.exit(1)
  }
  const body = m[2] ?? ''

  const lines = ['---']
  lines.push('type: decision')
  lines.push(
    `title: ${quoteIfNeeded('Knowledge Layer Foundation — code-coupled MD with frontmatter and staleness tracking')}`
  )
  lines.push('projectId: choda-deck')
  lines.push('scope: project')
  lines.push('refs:')
  for (const p of REF_PATHS) {
    lines.push(`  - path: ${p}`)
    lines.push(`    commitSha: ${sha}`)
  }
  lines.push(`createdAt: ${TODAY}`)
  lines.push(`lastVerifiedAt: ${TODAY}`)
  lines.push('---')
  const trimmed = body.replace(/^\r?\n+/, '')
  const out = lines.join('\n') + '\n\n' + trimmed + (trimmed.endsWith('\n') ? '' : '\n')

  fs.writeFileSync(ADR_PATH, out, 'utf8')
  console.log(`WROTE frontmatter with ${REF_PATHS.length} refs to ${ADR_PATH}`)

  console.log(
    [
      '',
      'DONE — next steps:',
      '  1. Commit the change on branch task-636.',
      '  2. After merge to main, run knowledge_verify to re-pin SHAs to merged HEAD',
      '     and sync the shared DB lastVerifiedAt + INDEX.md.',
      `     SLUG = ${SLUG}`
    ].join('\n')
  )
}

main()
