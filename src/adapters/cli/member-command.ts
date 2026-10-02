// TASK-2243 — `choda-deck member add|remove|list`: manage which projects a
// team member (their Keycloak preferred_username) may see on choda-remote.
// Talks to the remote Postgres named by CHODA_PG_URL when set, otherwise to the
// SQLite database under CHODA_DATA_DIR (TASK-2253: the live remote is SQLite).
// Exit 2 on usage errors, like the other command groups.

import type { PostgresProjectMemberRepository } from '../../core/domain/repositories/postgres/project-member-repository.pg'

export const MEMBER_HELP = `member add <member> <projectId>     Let <member> see <projectId> on the remote
member remove <member> <projectId>  Stop serving <projectId> to <member>
member list <member>                Print the project ids <member> belongs to
  <member> is the Keycloak preferred_username. Uses CHODA_PG_URL when set,
  otherwise the SQLite database under CHODA_DATA_DIR (the live remote).
`

export interface MemberIo {
  out: (text: string) => void
  err: (text: string) => void
}

type MemberRepo = Pick<PostgresProjectMemberRepository, 'add' | 'remove' | 'listProjectsFor'>

// Pure dispatch over an injected repository so tests run it in-process.
export async function runMemberCommand(
  sub: string | undefined,
  args: string[],
  repo: MemberRepo,
  io: MemberIo
): Promise<number> {
  if (sub === 'list') {
    const [member, extra] = args
    if (!member || extra !== undefined) return usage(io, 'member list takes exactly <member>')
    for (const projectId of await repo.listProjectsFor(member)) io.out(`${projectId}\n`)
    return 0
  }
  if (sub === 'add' || sub === 'remove') {
    const [member, projectId, extra] = args
    if (!member || !projectId || extra !== undefined) {
      return usage(io, `member ${sub} takes exactly <member> <projectId>`)
    }
    if (sub === 'add') {
      const result = await repo.add(member, projectId)
      if (result === 'unknown-project') {
        io.err(`error: unknown project "${projectId}"\n`)
        return 1
      }
      io.out(
        result === 'added'
          ? `added ${member} to ${projectId}\n`
          : `${member} is already a member of ${projectId}\n`
      )
      return 0
    }
    const result = await repo.remove(member, projectId)
    if (result === 'not-member') {
      io.err(`${member} is not a member of ${projectId}\n`)
      return 1
    }
    io.out(`removed ${member} from ${projectId}\n`)
    return 0
  }
  return usage(io, `unknown member subcommand "${sub ?? ''}"`)
}

function usage(io: MemberIo, message: string): number {
  io.err(`error: ${message}\n\n${MEMBER_HELP}`)
  return 2
}

export async function dispatchMember(sub: string | undefined, args: string[]): Promise<number> {
  const io: MemberIo = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t)
  }
  const connectionString = process.env.CHODA_PG_URL ?? ''
  if (connectionString.length === 0) {
    // TASK-2253 — the live remote runs SQLite: use the database at the resolved
    // data path (CHODA_DATA_DIR), e.g. via kubectl exec inside choda-deck-0.
    const { resolveDataPaths } = await import('../../core/paths')
    const { default: Database } = await import('better-sqlite3')
    const { initSchema } = await import('../../core/domain/repositories/schema')
    const { ProjectMemberRepository } = await import(
      '../../core/domain/repositories/project-member-repository'
    )
    const db = new Database(resolveDataPaths().dbPath)
    try {
      initSchema(db) // idempotent — guarantees project_members exists
      return await runMemberCommand(sub, args, new ProjectMemberRepository(db), io)
    } finally {
      db.close()
    }
  }
  const { PgConnection } = await import('../../core/domain/repositories/postgres/connection')
  const { migrate } = await import('../../core/domain/repositories/postgres/migrations')
  const { PostgresProjectMemberRepository } = await import(
    '../../core/domain/repositories/postgres/project-member-repository.pg'
  )
  const conn = new PgConnection(connectionString)
  try {
    await migrate(conn) // idempotent — guarantees project_members exists
    return await runMemberCommand(sub, args, new PostgresProjectMemberRepository(conn), io)
  } finally {
    await conn.close()
  }
}
