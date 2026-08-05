import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * TASK-1510 — `resolveDataPaths()` picks a directory and never looks inside it. On a
 * packaged install that means an empty %APPDATA% profile can win while a populated
 * directory sits elsewhere, and the app comes up blank with no indication it chose wrong.
 *
 * This module answers the question `resolveDataPaths` deliberately does not ask: *is there
 * actually a database here, and is there one somewhere else?* It only reports. Deciding
 * what to do (migrate, prompt, refuse to start) belongs to the caller — the Electron app
 * lives in a separate repo and this must stay a pure, testable function.
 */

const DB_FILENAME = 'choda-deck.db'

/** Where a database can sit inside a data dir. Order matters — current layout first. */
const LAYOUTS = [
  // Current: <dataDir>/database/choda-deck.db
  path.join('database', DB_FILENAME),
  // Pre-migration: <dataDir>/choda-deck.db at the root. scripts/migrate-data-layout.mjs
  // moved these, but an %APPDATA% profile abandoned before that ran still looks like this
  // — verified on a real machine 2026-08-05 (see docs/data-directory.md).
  DB_FILENAME
]

export interface FoundDatabase {
  /** The data dir that contains it. */
  dataDir: string
  /** Full path to the database file. */
  dbPath: string
  sizeBytes: number
  modifiedAt: Date
  /** True when the db sits at the dir root — the layout predating the data-dir migration. */
  legacyLayout: boolean
}

export interface DataDirReport {
  /** The directory resolveDataPaths chose. */
  chosen: string
  /** The database in the chosen dir, or null when it holds none. */
  chosenDatabase: FoundDatabase | null
  /**
   * Populated directories OTHER than the chosen one, largest first. Non-empty while
   * `chosenDatabase` is null is the exact condition AC-1 and AC-3 are about: starting
   * silently blank when the data is right there.
   */
  others: FoundDatabase[]
}

/** Read a database at `dbPath` if it exists and is non-empty. */
function probe(dataDir: string, relative: string): FoundDatabase | null {
  const dbPath = path.join(dataDir, relative)
  try {
    const stat = fs.statSync(dbPath)
    if (!stat.isFile() || stat.size === 0) return null
    return {
      dataDir,
      dbPath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      legacyLayout: relative === DB_FILENAME
    }
  } catch {
    // ENOENT and friends mean "no database here", which is a normal answer, not an error.
    return null
  }
}

/** The first database found in `dataDir` under any known layout, or null. */
export function findDatabase(dataDir: string): FoundDatabase | null {
  for (const layout of LAYOUTS) {
    const found = probe(dataDir, layout)
    if (found) return found
  }
  return null
}

/**
 * Directories worth checking when the chosen one turns out to be empty.
 *
 * Includes the pre-rename %APPDATA% profile: the Electron data dir is keyed on the app
 * name, so renaming choda-deck → choda-deck-companion silently created a fresh empty
 * profile and orphaned the old one. A rename is therefore a trigger for this bug in the
 * same way a fresh install is.
 */
export function defaultCandidates(cwd: string = process.cwd()): string[] {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  return [
    path.join(cwd, 'data'),
    path.join(appData, 'choda-deck-companion', 'data'),
    path.join(appData, 'choda-deck')
  ]
}

/**
 * Inspect the chosen data dir and the candidates around it.
 *
 * Reports only — never migrates, never writes. `others` excludes the chosen dir and any
 * duplicate that resolves to the same real path, so a directory junction pointing at the
 * chosen dir does not show up as a rival copy of itself.
 */
export function inspectDataDirs(chosen: string, candidates?: string[]): DataDirReport {
  const chosenReal = realPathOr(chosen)
  const chosenDatabase = findDatabase(chosen)

  const seen = new Set<string>([chosenReal])
  const others: FoundDatabase[] = []

  for (const candidate of candidates ?? defaultCandidates()) {
    const real = realPathOr(candidate)
    if (seen.has(real)) continue
    seen.add(real)
    const found = findDatabase(candidate)
    if (found) others.push(found)
  }

  others.sort((a, b) => b.sizeBytes - a.sizeBytes)
  return { chosen, chosenDatabase, others }
}

/** Resolve symlinks/junctions so the same directory reached two ways compares equal. */
function realPathOr(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    return path.resolve(dir)
  }
}

/**
 * The one case a caller must never ignore: the chosen dir is empty and another is not.
 * Starting here writes a second database and leaves no indication which is live (AC-3).
 */
export function isSilentlyEmpty(report: DataDirReport): boolean {
  return report.chosenDatabase === null && report.others.length > 0
}

/** A message a caller can put in front of a human. Never thrown — the caller decides. */
export function describeReport(report: DataDirReport): string {
  if (!isSilentlyEmpty(report)) return ''
  const lines = [
    `No database found in ${report.chosen}, but ${report.others.length} other location(s) hold one:`
  ]
  for (const other of report.others) {
    const size = `${(other.sizeBytes / 1024 / 1024).toFixed(1)} MB`
    const layout = other.legacyLayout ? ' [pre-migration layout]' : ''
    lines.push(`  ${other.dbPath} — ${size}, modified ${other.modifiedAt.toISOString()}${layout}`)
  }
  lines.push('Starting here would create a second database with no indication which is live.')
  return lines.join('\n')
}
