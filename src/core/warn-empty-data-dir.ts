import { inspectDataDirs, isSilentlyEmpty, describeReport } from './data-dir-probe'

/**
 * TASK-1510 AC-3 — warn on stderr when the chosen data dir is empty but another holds a
 * database. Starting here creates a second database with no indication which is live.
 *
 * **stderr, never stdout.** The MCP server speaks JSON-RPC over stdout on the stdio
 * transport; a stray line there corrupts the protocol rather than informing anyone.
 *
 * Warns rather than refuses. An empty dir is legitimate on a genuine first run, and a
 * process that exits non-zero because it found a directory elsewhere would be worse than
 * the bug. Deciding to migrate or prompt belongs to an interactive caller — the packaged
 * app, which lives in choda-deck-companion and can consume `inspectDataDirs` directly.
 *
 * Returns whether a warning was emitted, so callers can test it without capturing stderr.
 */
export function warnIfSilentlyEmpty(
  dataDir: string,
  write: (msg: string) => void = (m) => process.stderr.write(m),
  candidates?: string[]
): boolean {
  const report = inspectDataDirs(dataDir, candidates)
  if (!isSilentlyEmpty(report)) return false
  write(
    `[choda-deck] ${describeReport(report)}\n` +
      '[choda-deck] See docs/data-directory.md — set CHODA_DATA_DIR or use a directory junction.\n'
  )
  return true
}
