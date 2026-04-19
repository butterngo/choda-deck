import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { VaultService } from '../vault-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_ROOT = path.join(__dirname, '__test-vault__')

// Files created for resolution tests
const FILES = ['TASK-308_markdown-sync.md', 'context.md', 'ADR-002-multi-project-sidebar.md']

const SUBDIR = path.join(TEST_ROOT, 'tasks')

beforeAll(() => {
  fs.mkdirSync(SUBDIR, { recursive: true })
  for (const f of FILES) {
    fs.writeFileSync(path.join(TEST_ROOT, f), `# ${f}`)
  }
  // Also put one file in a subdir to test path-prefix wikilinks
  fs.writeFileSync(path.join(SUBDIR, 'TASK-001_init.md'), '# TASK-001')
})

afterAll(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('VaultService.resolveWikilink', () => {
  const svc = new VaultService()

  it('resolves plain wikilink', () => {
    const result = svc.resolveWikilink('TASK-308_markdown-sync', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves wikilink with [[]] brackets still in string', () => {
    const result = svc.resolveWikilink('[[TASK-308_markdown-sync]]', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves wikilink with pipe alias', () => {
    const result = svc.resolveWikilink('TASK-308_markdown-sync|TASK-308', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves wikilink with [[]] and pipe alias', () => {
    const result = svc.resolveWikilink('[[TASK-308_markdown-sync|display text]]', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves wikilink with path prefix', () => {
    const result = svc.resolveWikilink('tasks/TASK-308_markdown-sync', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves wikilink with .md extension', () => {
    const result = svc.resolveWikilink('TASK-308_markdown-sync.md', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves case-insensitive', () => {
    const result = svc.resolveWikilink('task-308_markdown-sync', TEST_ROOT)
    expect(result).toBe(path.join(TEST_ROOT, 'TASK-308_markdown-sync.md'))
  })

  it('resolves file in subdirectory', () => {
    const result = svc.resolveWikilink('TASK-001_init', TEST_ROOT)
    expect(result).toBe(path.join(SUBDIR, 'TASK-001_init.md'))
  })

  it('returns null for unknown wikilink', () => {
    const result = svc.resolveWikilink('TASK-999_does-not-exist', TEST_ROOT)
    expect(result).toBeNull()
  })

  it('returns null for empty string', () => {
    const result = svc.resolveWikilink('', TEST_ROOT)
    expect(result).toBeNull()
  })

  it('rebuilds cache when rootPath changes', () => {
    const otherRoot = path.join(__dirname, '__test-other__')
    fs.mkdirSync(otherRoot, { recursive: true })
    fs.writeFileSync(path.join(otherRoot, 'other-note.md'), '# other')

    try {
      // Prime cache with TEST_ROOT
      svc.resolveWikilink('context', TEST_ROOT)
      // Switch to different root — should NOT find TEST_ROOT files
      const result = svc.resolveWikilink('context', otherRoot)
      expect(result).toBeNull()
      // Should find the other root's file
      const result2 = svc.resolveWikilink('other-note', otherRoot)
      expect(result2).toBe(path.join(otherRoot, 'other-note.md'))
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true })
    }
  })
})
