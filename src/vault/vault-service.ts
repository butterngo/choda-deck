import { readdirSync, readFileSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import type { FileNode, FileStat, SearchResult } from './vault-types'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.claude'])
const MAX_SEARCH_RESULTS = 50
const MAX_MATCHES_PER_FILE = 5

export class VaultService {
  private wikilinkCache: Map<string, string> | null = null
  private cacheRoot: string | null = null

  readTree(rootPath: string): FileNode[] {
    return this.readDir(rootPath)
  }

  readFile(filePath: string): FileStat {
    const content = readFileSync(filePath, 'utf-8')
    const stat = statSync(filePath)
    return {
      content,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    }
  }

  search(query: string, rootPath: string): SearchResult[] {
    const results: SearchResult[] = []
    const pattern = new RegExp(this.escapeRegex(query), 'i')
    this.searchDir(rootPath, pattern, results)
    return results.slice(0, MAX_SEARCH_RESULTS)
  }

  resolveWikilink(wikilink: string, rootPath: string): string | null {
    if (!this.wikilinkCache || this.cacheRoot !== rootPath) {
      this.buildWikilinkCache(rootPath)
    }
    const key = wikilink.toLowerCase().replace(/\[\[|\]\]/g, '').trim()
    return this.wikilinkCache!.get(key) || null
  }

  invalidateCache(): void {
    this.wikilinkCache = null
    this.cacheRoot = null
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private readDir(dirPath: string): FileNode[] {
    const entries = readdirSync(dirPath, { withFileTypes: true })
    const nodes: FileNode[] = []

    // Sort: directories first, then files, alphabetical within each group
    const dirs = entries.filter(e => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'))

    dirs.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.name.localeCompare(b.name))

    for (const dir of dirs) {
      const fullPath = join(dirPath, dir.name)
      nodes.push({
        name: dir.name,
        path: fullPath,
        type: 'directory',
        children: this.readDir(fullPath)
      })
    }

    for (const file of files) {
      nodes.push({
        name: file.name,
        path: join(dirPath, file.name),
        type: 'file'
      })
    }

    return nodes
  }

  private searchDir(dirPath: string, pattern: RegExp, results: SearchResult[]): void {
    if (results.length >= MAX_SEARCH_RESULTS) return

    const entries = readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (results.length >= MAX_SEARCH_RESULTS) return
      const fullPath = join(dirPath, entry.name)

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          this.searchDir(fullPath, pattern, results)
        }
        continue
      }

      if (!entry.isFile() || extname(entry.name) !== '.md') continue

      try {
        const content = readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')
        const matches: { line: number; text: string }[] = []

        for (let i = 0; i < lines.length; i++) {
          if (pattern.test(lines[i])) {
            matches.push({ line: i + 1, text: lines[i].trim() })
            if (matches.length >= MAX_MATCHES_PER_FILE) break
          }
        }

        if (matches.length > 0) {
          results.push({
            path: fullPath,
            name: entry.name,
            matches
          })
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  private buildWikilinkCache(rootPath: string): void {
    this.wikilinkCache = new Map()
    this.cacheRoot = rootPath
    this.indexDir(rootPath)
  }

  private indexDir(dirPath: string): void {
    const entries = readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)

      if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
        this.indexDir(fullPath)
        continue
      }

      if (entry.isFile()) {
        const nameWithoutExt = basename(entry.name, extname(entry.name))
        this.wikilinkCache!.set(nameWithoutExt.toLowerCase(), fullPath)
      }
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
}
