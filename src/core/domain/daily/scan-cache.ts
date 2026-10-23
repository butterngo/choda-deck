import { scanWorkspaces, type RepoScan, type ScanWorkspaceInput } from './workspace-scan'

// TASK-2704 — the git half of GET /daily-report from memory, so opening the
// Today screen does not wait on a scan (≈ 4 s over 25 repos, two thirds of it
// `gh pr list`). Git state changes when Butter commits, not between two page
// loads, so a scan up to SCAN_TTL_MS old is served as it is.
//
//   no scan yet, or fresh      → scan now and wait for it
//   younger than the TTL       → the cached scan
//   older than the TTL         → the cached scan at once, plus ONE background rescan
//
// Only one scan runs at a time: a caller that needs a scan while one is running
// waits for that one. The cache keeps each RepoScan exactly as the scan returned
// it, so a failed/missing/not-a-repo repo stays unscanned on every cached call.
// A different workspace list (one added or removed) is a cache miss.

export const SCAN_TTL_MS = 5 * 60 * 1000

export interface CachedScan {
  scans: RepoScan[]
  /** ISO time the scan started. */
  scannedAt: string
}

export interface ScanCache {
  get(workspaces: ScanWorkspaceInput[], opts?: { fresh?: boolean }): Promise<CachedScan>
}

export interface ScanCacheOptions {
  scan?: (workspaces: ScanWorkspaceInput[]) => Promise<RepoScan[]>
  now?: () => number
  ttlMs?: number
}

const keyOf = (workspaces: ScanWorkspaceInput[]): string =>
  workspaces
    .map((w) => `${w.id}\u0000${w.projectId}\u0000${w.cwd}`)
    .sort()
    .join('\u0001')

export function createScanCache(opts: ScanCacheOptions = {}): ScanCache {
  const scan = opts.scan ?? ((ws: ScanWorkspaceInput[]) => scanWorkspaces(ws))
  const now = opts.now ?? Date.now
  const ttlMs = opts.ttlMs ?? SCAN_TTL_MS
  let cached: (CachedScan & { key: string; at: number }) | null = null
  let inflight: { key: string; promise: Promise<CachedScan> } | null = null

  const run = (workspaces: ScanWorkspaceInput[], key: string): Promise<CachedScan> => {
    if (inflight && inflight.key === key) return inflight.promise
    const at = now()
    const promise = scan(workspaces)
      .then((scans) => {
        const result = { scans, scannedAt: new Date(at).toISOString() }
        if (!cached || cached.at <= at) cached = { ...result, key, at }
        return result
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
    inflight = { key, promise }
    return promise
  }

  return {
    async get(workspaces, { fresh = false } = {}) {
      const key = keyOf(workspaces)
      if (fresh || !cached || cached.key !== key) return run(workspaces, key)
      if (now() - cached.at >= ttlMs && !inflight) {
        // A failed background rescan keeps the old scan; the next call retries.
        run(workspaces, key).catch(() => undefined)
      }
      return { scans: cached.scans, scannedAt: cached.scannedAt }
    }
  }
}
