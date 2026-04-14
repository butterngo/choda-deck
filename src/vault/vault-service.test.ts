import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { VaultService } from './vault-service'
import * as fs from 'fs'
import * as path from 'path'

const TEST_ROOT = path.join(__dirname, '__test-vault__')

function mkDir(...segments: string[]): void {
  fs.mkdirSync(path.join(TEST_ROOT, ...segments), { recursive: true })
}

function mkFile(content: string, ...segments: string[]): void {
  const filePath = path.join(TEST_ROOT, ...segments)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
}

function rmDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

describe('VaultService', () => {
  let svc: VaultService

  beforeAll(() => {
    rmDir(TEST_ROOT)
    mkDir()

    // Build a small vault structure
    mkFile('# Project A\n\nSome content about SQLite.', '10-Projects', 'project-a.md')
    mkFile('# Task 1\n\nImplement feature.\n\nDepends on [[project-a]].', '10-Projects', 'tasks', 'TASK-001.md')
    mkFile('# ADR-001\n\nWe chose SQLite for task management.', '10-Projects', 'decisions', 'ADR-001.md')
    mkFile('# Daily\n\nToday I worked on sqlite queries.', '00-Daily', 'daily.md')
    mkFile('plain text file', 'readme.txt')
    mkDir('.git')
    mkFile('ref: refs/heads/main', '.git', 'HEAD')
    mkDir('node_modules')
    mkFile('{}', 'node_modules', 'pkg.json')

    svc = new VaultService()
  })

  afterAll(() => {
    rmDir(TEST_ROOT)
  })

  // ── readTree ────────────────────────────────────────────────────────────

  it('returns recursive directory tree', () => {
    const tree = svc.readTree(TEST_ROOT)
    const names = tree.map(n => n.name)

    expect(names).toContain('00-Daily')
    expect(names).toContain('10-Projects')
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
  })

  it('includes files in tree', () => {
    const tree = svc.readTree(TEST_ROOT)
    const files = tree.filter(n => n.type === 'file')
    expect(files.some(f => f.name === 'readme.txt')).toBe(true)
  })

  it('sorts directories before files', () => {
    const tree = svc.readTree(TEST_ROOT)
    const firstDir = tree.findIndex(n => n.type === 'directory')
    const firstFile = tree.findIndex(n => n.type === 'file')
    if (firstDir >= 0 && firstFile >= 0) {
      expect(firstDir).toBeLessThan(firstFile)
    }
  })

  it('includes nested children', () => {
    const tree = svc.readTree(TEST_ROOT)
    const projects = tree.find(n => n.name === '10-Projects')
    expect(projects).toBeDefined()
    expect(projects!.children).toBeDefined()
    expect(projects!.children!.some(c => c.name === 'project-a.md')).toBe(true)

    const tasks = projects!.children!.find(c => c.name === 'tasks')
    expect(tasks).toBeDefined()
    expect(tasks!.children!.some(c => c.name === 'TASK-001.md')).toBe(true)
  })

  // ── readFile ────────────────────────────────────────────────────────────

  it('reads file content and stat', () => {
    const filePath = path.join(TEST_ROOT, '10-Projects', 'project-a.md')
    const result = svc.readFile(filePath)

    expect(result.content).toContain('# Project A')
    expect(result.content).toContain('SQLite')
    expect(result.size).toBeGreaterThan(0)
    expect(result.mtime).toBeTruthy()
    expect(new Date(result.mtime).getTime()).not.toBeNaN()
  })

  it('throws for non-existent file', () => {
    const badPath = path.join(TEST_ROOT, 'does-not-exist.md')
    expect(() => svc.readFile(badPath)).toThrow()
  })

  // ── search ──────────────────────────────────────────────────────────────

  it('finds matches across .md files', () => {
    const results = svc.search('SQLite', TEST_ROOT)
    expect(results.length).toBeGreaterThanOrEqual(2)

    const paths = results.map(r => r.name)
    expect(paths).toContain('project-a.md')
    expect(paths).toContain('ADR-001.md')
  })

  it('search is case-insensitive', () => {
    const results = svc.search('sqlite', TEST_ROOT)
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('returns line numbers and text', () => {
    const results = svc.search('Project A', TEST_ROOT)
    const match = results.find(r => r.name === 'project-a.md')
    expect(match).toBeDefined()
    expect(match!.matches.length).toBeGreaterThan(0)
    expect(match!.matches[0].line).toBe(1)
    expect(match!.matches[0].text).toContain('Project A')
  })

  it('returns empty for no matches', () => {
    const results = svc.search('zzz_nonexistent_zzz', TEST_ROOT)
    expect(results).toEqual([])
  })

  it('skips non-.md files', () => {
    const results = svc.search('plain text', TEST_ROOT)
    expect(results).toEqual([])
  })

  it('skips ignored directories', () => {
    const results = svc.search('refs/heads', TEST_ROOT)
    expect(results).toEqual([])
  })

  // ── resolveWikilink ─────────────────────────────────────────────────────

  it('resolves wikilink to absolute path', () => {
    const resolved = svc.resolveWikilink('project-a', TEST_ROOT)
    expect(resolved).not.toBeNull()
    expect(resolved!).toContain('project-a.md')
  })

  it('resolves wikilink with brackets', () => {
    const resolved = svc.resolveWikilink('[[TASK-001]]', TEST_ROOT)
    expect(resolved).not.toBeNull()
    expect(resolved!).toContain('TASK-001.md')
  })

  it('resolves case-insensitively', () => {
    const resolved = svc.resolveWikilink('PROJECT-A', TEST_ROOT)
    expect(resolved).not.toBeNull()
  })

  it('returns null for unknown wikilink', () => {
    const resolved = svc.resolveWikilink('does-not-exist', TEST_ROOT)
    expect(resolved).toBeNull()
  })

  it('does not resolve files in ignored dirs', () => {
    const resolved = svc.resolveWikilink('HEAD', TEST_ROOT)
    expect(resolved).toBeNull()
  })

  // ── cache invalidation ─────────────────────────────────────────────────

  it('invalidateCache forces rebuild on next resolve', () => {
    // First resolve builds cache
    svc.resolveWikilink('project-a', TEST_ROOT)

    // Add a new file
    mkFile('# New Note', 'new-note.md')

    // Cache still returns null (stale)
    expect(svc.resolveWikilink('new-note', TEST_ROOT)).toBeNull()

    // After invalidation, cache rebuilds
    svc.invalidateCache()
    const resolved = svc.resolveWikilink('new-note', TEST_ROOT)
    expect(resolved).not.toBeNull()
    expect(resolved!).toContain('new-note.md')
  })
})
