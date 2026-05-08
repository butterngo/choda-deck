import { parseArgs } from 'node:util'
import * as readline from 'node:readline/promises'
import * as fs from 'fs'
import * as path from 'path'
import Database from 'better-sqlite3'

import { resolveDataPaths } from '../../../core/paths'
import { initSchema } from '../../../core/domain/repositories/schema'
import { runImport } from '../../../core/sync/import-service'
import { runPreflight, formatPreflightSummary } from '../../../core/sync/preflight'
import {
  loadPathsMapping,
  savePathsMapping,
  setMapping,
  identityKey,
  type PathsMapping
} from '../../../core/sync/paths-mapping'
import type { WorkspaceIdentity } from '../../../core/sync/snapshot-types'

export const syncImportHelp = `Usage: choda-deck sync import --from <dir> [options]

Required:
  --from <dir>        Snapshot directory (must contain manifest.json + 7 domain files)

Options:
  --dry-run           Run preflight + print delete diff, exit before any write
  --yes               CI mode: skip confirm + missing-mapping prompts (errors instead)
  --json              Emit machine-readable result instead of human summary
  --help              Show this help

  --dry-run and --yes are mutually exclusive.

Behaviour:
  1. Validates manifest + domain files
  2. Resolves workspace identities to local paths via paths.local.json
     (prompts once for any missing mapping in interactive mode)
  3. Prints rows that will be DELETED (not present in incoming snapshot,
     per project in manifest.projectIds — capped at 20 per table)
  4. Asks for confirm (skipped in --yes / --dry-run mode)
  5. Writes pre-import-<ts>.db backup, then applies the snapshot atomically
`

export async function runSyncImport(argv: string[]): Promise<number> {
  const parsed = parseArgs({
    args: argv,
    options: {
      from: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: false,
    strict: true
  })

  const v = parsed.values
  if (v.help) {
    process.stdout.write(syncImportHelp)
    return 0
  }

  if (v['dry-run'] && v.yes) {
    process.stderr.write('error: --dry-run and --yes are mutually exclusive\n')
    return 2
  }

  if (!v.from) {
    process.stderr.write('error: --from <dir> is required\n\n' + syncImportHelp)
    return 2
  }

  const snapshotDir = path.resolve(v.from)
  if (!fs.existsSync(snapshotDir)) {
    process.stderr.write(`error: snapshot directory does not exist: ${snapshotDir}\n`)
    return 1
  }

  const { dbPath, dataDir } = resolveDataPaths()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  // Ensure schema exists so we can import into a fresh DB on a new machine.
  initSchema(db)

  try {
    let pathsMapping = loadPathsMapping(dataDir)

    // Initial preflight surfaces missing mappings + delete diff.
    const initial = runPreflight({
      snapshotDir,
      db,
      pathsMapping,
      yes: v.yes ?? false
    })

    if (v['dry-run']) {
      if (v.json) {
        process.stdout.write(
          JSON.stringify(
            {
              status: 'dry-run',
              preflight: {
                ok: initial.ok,
                errors: initial.errors,
                warnings: initial.warnings,
                deletePlan: initial.deletePlan,
                missingMappings: initial.missingMappings,
                knowledgeMissing: initial.knowledgeMissing
              }
            },
            null,
            2
          ) + '\n'
        )
      } else {
        process.stdout.write(formatPreflightSummary(initial) + '\n')
      }
      return initial.ok ? 0 : 1
    }

    // Hard preflight failures (excluding the missing-mapping case which we
    // can resolve interactively below) abort before backup or txn.
    const fatalErrors = initial.errors.filter((e) => !/missing local path mapping/.test(e))
    if (fatalErrors.length > 0) {
      process.stderr.write('Preflight failed:\n' + fatalErrors.map((e) => `  - ${e}`).join('\n') + '\n')
      return 1
    }

    // Resolve missing mappings interactively, then persist.
    if (initial.missingMappings.length > 0) {
      if (v.yes) {
        process.stderr.write(
          `error: ${initial.missingMappings.length} workspace(s) lack a local path mapping ` +
            `and --yes disables prompting. Re-run without --yes.\n`
        )
        return 1
      }
      pathsMapping = await promptForMappings(initial.missingMappings, pathsMapping)
      savePathsMapping(dataDir, pathsMapping)
    }

    // Confirm delete diff with the user.
    if (initial.deletePlan.length > 0 && !v.yes) {
      process.stdout.write(formatPreflightSummary(initial) + '\n\n')
      const ok = await promptYesNo('Apply this snapshot?')
      if (!ok) {
        process.stdout.write('aborted by user\n')
        return 1
      }
    }

    const result = runImport({
      snapshotDir,
      db,
      pathsMapping,
      dataDir,
      yes: v.yes ?? undefined
    })

    if (v.json) {
      process.stdout.write(
        JSON.stringify(
          {
            status: result.status,
            backupPath: result.backupPath,
            rowCounts: result.rowCounts.filter((c) => c.deleted > 0 || c.inserted > 0)
          },
          null,
          2
        ) + '\n'
      )
    } else {
      process.stdout.write(`sync import — ${result.status}\n`)
      process.stdout.write(`  backup: ${result.backupPath}\n`)
      const significant = result.rowCounts.filter((c) => c.deleted > 0 || c.inserted > 0)
      for (const c of significant) {
        process.stdout.write(`  ${c.table}: -${c.deleted} +${c.inserted}\n`)
      }
    }
    return 0
  } finally {
    db.close()
  }
}

async function promptForMappings(
  missing: WorkspaceIdentity[],
  mapping: PathsMapping
): Promise<PathsMapping> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let updated = mapping
  try {
    for (const m of missing) {
      const key = identityKey(m)
      const ans = await rl.question(`Local path for ${key} (workspace=${m.workspaceId}): `)
      const trimmed = ans.trim()
      if (trimmed.length === 0) {
        process.stderr.write(`(skipped ${key})\n`)
        continue
      }
      updated = setMapping(updated, key, path.resolve(trimmed))
    }
  } finally {
    rl.close()
  }
  return updated
}

async function promptYesNo(q: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const ans = await rl.question(`${q} [y/N] `)
    return ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}
