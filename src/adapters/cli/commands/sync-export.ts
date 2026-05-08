import { parseArgs } from 'node:util'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'

import { resolveDataPaths } from '../../../core/paths'
import { runExport } from '../../../core/sync/export-service'

export const syncExportHelp = `Usage: choda-deck sync export --to <dir> [options]

Required (one of):
  --to <dir>          Destination directory for the snapshot
  CHODA_EXPORT_DIR    Env var fallback for --to

Options:
  --project <id>      Repeat to limit to specific projects (default: all)
  --json              Emit machine-readable result instead of human summary
  --help              Show this help

Output files in <dir>:
  manifest.json + projects.json + workspaces.json + tasks.json
  conversations.json + inbox.json + sessions.json + knowledge.json

Manifest is written LAST so a partial export is detectable. With no DB
changes between runs, output bytes are stable (no-op skip + metadata-refresh).
`

interface SyncExportResultPayload {
  status: string
  outDir: string
  contentHash: string
  filesWritten: string[]
}

export async function runSyncExport(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      project: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  const v = parsed.values
  if (v.help) {
    process.stdout.write(syncExportHelp)
    return 0
  }

  const outDir = v.to ?? process.env.CHODA_EXPORT_DIR
  if (!outDir) {
    process.stderr.write(
      'error: --to <dir> is required (or set CHODA_EXPORT_DIR)\n\n' +
        '  Example: choda-deck sync export --to /path/to/sync-repo\n\n' +
        syncExportHelp
    )
    return 1
  }

  const projectIds = v.project as string[] | undefined

  const { dbPath } = resolveDataPaths()
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`error: database not found at ${dbPath}\n`)
    return 1
  }

  const appVersion = readAppVersion()

  const db = new Database(dbPath, { readonly: true })
  try {
    const result = runExport({
      outDir: path.resolve(outDir),
      appVersion,
      db,
      projectIds: projectIds && projectIds.length > 0 ? projectIds : undefined
    })

    if (v.json) {
      const payload: SyncExportResultPayload = {
        status: result.status,
        outDir: result.outDir,
        contentHash: result.contentHash,
        filesWritten: result.filesWritten
      }
      process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
      return 0
    }

    const fileList = result.filesWritten.length > 0 ? result.filesWritten.join(', ') : '(none)'
    process.stdout.write(
      `sync export — ${result.status}\n` +
        `  outDir: ${result.outDir}\n` +
        `  contentHash: ${result.contentHash}\n` +
        `  filesWritten: ${fileList}\n`
    )
    return 0
  } finally {
    db.close()
  }
}

function readAppVersion(): string {
  // package.json sits at the repo root regardless of where the CLI is invoked
  // from. Resolve relative to the bundled module location at runtime.
  try {
    const here = path.dirname(__filename)
    let dir = here
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, 'package.json')
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (typeof pkg.version === 'string') return pkg.version
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* fall through */
  }
  return '0.0.0-unknown'
}
