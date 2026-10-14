import * as fs from 'fs'

// TASK-2312 — `choda-deck session reconcile`. Thin adapter: open the DB read-only
// (never create one) and print one line per ACTIVE session whose task already
// merged. Exit 2 on usage errors, like `activity`.

export const SESSION_HELP = `session reconcile
  List ACTIVE sessions older than 3 days whose task id is named by a merged PR on
  the workspace's default branch. Read-only: prints one line per session.
`

export async function dispatchSession(sub: string | undefined, args: string[]): Promise<number> {
  if (sub !== 'reconcile') {
    process.stderr.write(
      `error: unknown session subcommand "${sub ?? ''}" — only "session reconcile" is supported\n\n${SESSION_HELP}`
    )
    return 2
  }
  if (args.length) {
    process.stderr.write(`error: unknown option "${args[0]}"\n\n${SESSION_HELP}`)
    return 2
  }

  const { resolveDataPaths } = await import('../../core/paths')
  const { findStaleSessions } = await import('../../core/domain/activity/session-reconcile')
  const { default: Database } = await import('better-sqlite3')

  const { dbPath } = resolveDataPaths()
  if (!fs.existsSync(dbPath)) return 0
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    for (const s of findStaleSessions(db)) {
      process.stdout.write(
        `${s.sessionId}  ${s.taskId}  started ${s.startedAt.slice(0, 10)}  ${s.cwd}  merged: ${s.mergedBy}\n`
      )
    }
    return 0
  } finally {
    db.close()
  }
}
