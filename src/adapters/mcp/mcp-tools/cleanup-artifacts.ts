import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { splitLines } from '../../../core/utils/lines'
import type { InstrumentedServer } from '../instrumented-server'
import { textResponse } from './types'

interface KeptEntry {
  path: string
  reason: string
}

interface DeletedEntry {
  path: string
  sizeBytes: number
  mtime: string
}

interface ArtifactCleanupResult {
  dryRun: boolean
  keepLastN: number
  totalDirs: number
  kept: KeptEntry[]
  deleted: DeletedEntry[]
  candidates?: DeletedEntry[]
}

function hasFailedEvent(dirPath: string): boolean {
  const jsonlPath = path.join(dirPath, 'queue.jsonl')
  if (!fs.existsSync(jsonlPath)) return false
  const content = fs.readFileSync(jsonlPath, 'utf8')
  return splitLines(content).some((line) => {
    if (!line.trim()) return false
    try {
      const parsed = JSON.parse(line) as { event?: string }
      return parsed.event === 'run.failed'
    } catch {
      return false
    }
  })
}

function dirSizeBytes(dirPath: string): number {
  let total = 0
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      total += dirSizeBytes(full)
    } else {
      total += fs.statSync(full).size
    }
  }
  return total
}

export const register = (server: InstrumentedServer, artifactsDir: string): void => {
  server.registerTool(
    'cleanup_artifacts',
    {
      description:
        'Prune old queue artifact directories under the artifacts dir. ' +
        'Keeps the newest keepLastN dirs, any dir with a run.failed event in queue.jsonl, ' +
        'and any dir missing queue.jsonl (pre-TASK-741 era). ' +
        'Default dry-run — pass dryRun=false to delete.',
      inputSchema: {
        keepLastN: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Number of newest dirs to keep. Default 100.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Default true — list candidates without deleting. Pass false to apply.')
      }
    },
    async ({ keepLastN, dryRun }) => {
      const n = keepLastN ?? 100
      const isDryRun = dryRun ?? true

      if (!fs.existsSync(artifactsDir)) {
        const result: ArtifactCleanupResult = {
          dryRun: isDryRun,
          keepLastN: n,
          totalDirs: 0,
          kept: [],
          deleted: []
        }
        return textResponse(result)
      }

      const entries = fs.readdirSync(artifactsDir, { withFileTypes: true })
      const queueDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('queue-'))
        .map((e) => {
          const full = path.join(artifactsDir, e.name)
          const stat = fs.statSync(full)
          return { path: full, mtimeMs: stat.mtimeMs, mtime: stat.mtime.toISOString() }
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs)

      const totalDirs = queueDirs.length
      const kept: KeptEntry[] = []
      const toDelete: DeletedEntry[] = []

      queueDirs.forEach((dir, i) => {
        if (i < n) {
          kept.push({ path: dir.path, reason: 'top-N' })
          return
        }
        const jsonlPath = path.join(dir.path, 'queue.jsonl')
        if (!fs.existsSync(jsonlPath)) {
          kept.push({ path: dir.path, reason: 'pre-TASK-741' })
          return
        }
        if (hasFailedEvent(dir.path)) {
          kept.push({ path: dir.path, reason: 'failed-run' })
          return
        }
        toDelete.push({ path: dir.path, sizeBytes: dirSizeBytes(dir.path), mtime: dir.mtime })
      })

      if (isDryRun) {
        const result: ArtifactCleanupResult = {
          dryRun: true,
          keepLastN: n,
          totalDirs,
          kept,
          deleted: [],
          candidates: toDelete
        }
        return textResponse(result)
      }

      const deleted: DeletedEntry[] = []
      for (const d of toDelete) {
        fs.rmSync(d.path, { recursive: true, force: true })
        deleted.push(d)
      }

      const result: ArtifactCleanupResult = {
        dryRun: false,
        keepLastN: n,
        totalDirs,
        kept,
        deleted
      }
      return textResponse(result)
    }
  )
}
