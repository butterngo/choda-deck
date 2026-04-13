/**
 * Vault Importer — parse vault .md files into SQLite
 * Watches for file changes and re-imports.
 */

import * as fs from 'fs'
import * as path from 'path'
import matter from 'gray-matter'
import * as chokidar from 'chokidar'
import type { SqliteTaskService } from './sqlite-task-service'
import type { TaskStatus, TaskPriority } from './task-types'

const DEFAULT_STATUS_MAP: Record<string, TaskStatus> = {
  'todo': 'TODO',
  'open': 'TODO',
  'ready': 'READY',
  'in-progress': 'IN-PROGRESS',
  'in progress': 'IN-PROGRESS',
  'doing': 'IN-PROGRESS',
  'done': 'DONE',
  'closed': 'DONE'
}

function normalizeStatus(raw: string | undefined, statusMap: Record<string, TaskStatus>): TaskStatus {
  if (!raw) return 'TODO'
  return statusMap[raw.toLowerCase()] || 'TODO'
}

function normalizePriority(raw: string | undefined): TaskPriority | null {
  if (!raw) return null
  const lower = raw.toLowerCase()
  if (['critical', 'high', 'medium', 'low'].includes(lower)) return lower as TaskPriority
  return null
}

function extractTaskId(filename: string): string | null {
  const match = filename.match(/^((?:TASK|BUG)-\d+[a-z]?)/)
  return match ? match[1] : null
}

function normalizeDependsOn(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

interface ImportResult {
  imported: number
  skipped: number
  errors: string[]
}

export class VaultImporter {
  private taskService: SqliteTaskService
  private vaultPath: string
  private statusMap: Record<string, TaskStatus>
  private watcher: chokidar.FSWatcher | null = null
  private ignoreSet = new Set<string>()

  constructor(taskService: SqliteTaskService, vaultPath: string, statusMap?: Record<string, string>) {
    this.taskService = taskService
    this.vaultPath = vaultPath
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...(statusMap || {}) } as Record<string, TaskStatus>
  }

  /**
   * Full import: scan all task folders, import into SQLite
   */
  importAll(projectConfigs: Array<{ id: string; taskPath: string }>): ImportResult {
    const result: ImportResult = { imported: 0, skipped: 0, errors: [] }

    for (const proj of projectConfigs) {
      this.taskService.ensureProject(proj.id, proj.id, proj.taskPath)

      // Scan taskPath/tasks/ directly (e.g. vault/10-Projects/automation-rule/tasks/)
      const tasksDir = path.join(proj.taskPath, 'tasks')
      if (!fs.existsSync(tasksDir)) continue

      const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const imported = this.importTaskFile(path.join(tasksDir, file), proj.id)
          if (imported) result.imported++
          else result.skipped++
        } catch (err) {
          result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      // Scan archive (vault/90-Archive/{project.id}/)
      const archiveDir = path.join(this.vaultPath, '90-Archive', proj.id)
      if (fs.existsSync(archiveDir)) {
        const archiveFiles = fs.readdirSync(archiveDir).filter(f => f.endsWith('.md'))
        for (const file of archiveFiles) {
          const taskId = extractTaskId(file)
          if (!taskId) continue
          try {
            const imported = this.importTaskFile(path.join(archiveDir, file), proj.id, true)
            if (imported) result.imported++
            else result.skipped++
          } catch (err) {
            result.errors.push(`archive/${file}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    }

    return result
  }

  /**
   * Import a single task .md file into SQLite
   */
  private importTaskFile(filePath: string, projectId: string, archived = false): boolean {
    const filename = path.basename(filePath)
    const taskId = extractTaskId(filename)
    if (!taskId) return false

    const content = fs.readFileSync(filePath, 'utf-8')
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(content)
    } catch {
      return false
    }

    const fm = parsed.data
    if (!fm || Object.keys(fm).length === 0) return false

    const status = archived ? 'DONE' : normalizeStatus(fm.status, this.statusMap)
    const priority = normalizePriority(fm.priority)
    const title = fm.title || taskId

    const existing = this.taskService.getTask(taskId)
    if (existing) {
      // Update existing
      this.taskService.updateTask(taskId, {
        title,
        status,
        priority,
        labels: fm.labels || undefined
      })
    } else {
      // Create new
      this.taskService.createTask({
        id: taskId,
        projectId,
        title,
        status,
        priority: priority || undefined,
        labels: fm.labels,
        filePath
      })
    }

    // Import dependencies
    const deps = normalizeDependsOn(fm['depends-on'])
    for (const dep of deps) {
      // Only add if target exists
      if (this.taskService.getTask(dep)) {
        this.taskService.addDependency(taskId, dep)
      }
    }

    return true
  }

  /**
   * Start watching vault task folders for changes
   */
  startWatching(projectIds: string[]): void {
    const watchPaths = projectIds.flatMap(id => [
      path.join(this.vaultPath, '10-Projects', id, 'tasks'),
      path.join(this.vaultPath, '90-Archive', id)
    ]).filter(p => fs.existsSync(p))

    if (watchPaths.length === 0) return

    this.watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    })

    this.watcher.on('change', (filePath) => {
      this.handleFileChange(filePath)
    })

    this.watcher.on('add', (filePath) => {
      this.handleFileChange(filePath)
    })
  }

  private handleFileChange(filePath: string): void {
    // Skip if we wrote this file (avoid loop)
    if (this.ignoreSet.has(filePath)) {
      this.ignoreSet.delete(filePath)
      return
    }

    if (!filePath.endsWith('.md')) return

    // Determine project from path
    const relative = path.relative(this.vaultPath, filePath)
    const parts = relative.split(path.sep)

    let projectId: string | null = null
    let archived = false

    if (parts[0] === '10-Projects' && parts.length >= 4) {
      projectId = parts[1]
    } else if (parts[0] === '90-Archive' && parts.length >= 3) {
      projectId = parts[1]
      archived = true
    }

    if (!projectId) return

    try {
      this.importTaskFile(filePath, projectId, archived)
    } catch {
      // Ignore import errors from watcher
    }
  }

  /**
   * Mark a file as "we wrote it" to prevent re-import loop
   */
  ignoreNextChange(filePath: string): void {
    this.ignoreSet.add(filePath)
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
