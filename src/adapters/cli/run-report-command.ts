import * as fs from 'fs'
import * as path from 'path'
import { execFileSync } from 'child_process'
import {
  buildRunReport,
  parseSmoke,
  renderRunReport,
  reportFileName,
  type RunReportDeps,
  type Smoke
} from '../../core/domain/services/run-report'

// TASK-2600 — `choda-deck run report <goalId> [--smoke <file.json>] [--out <path>]`.
// Writes the goal's test report and prints its path. Exit codes: 2 usage or
// unknown goal, 3 an invalid smoke file (nothing written).

export const RUN_HELP = `run report <goalId> [--smoke <file.json>] [--out <path>]
  Write the goal's test report (suite, tests added, AC coverage, smoke,
  regression) to <goal home workspace>/docs/reports/<goal>-test-report.md,
  or to --out, and print the path.
`

export interface RunIo {
  out(text: string): void
  err(text: string): void
}

export type RunReportCommandDeps = RunReportDeps & {
  /** The goal's home workspace cwd: the project's own cwd. */
  homeCwd(goalId: string): Promise<string | null>
}

/** `git show` of one commit, patch only; null when the repo does not have it. */
export function gitShow(cwd: string, sha: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'show', '--format=', '--no-color', '--no-ext-diff', sha], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
}

export async function runReportCommand(args: string[], io: RunIo, deps: RunReportCommandDeps): Promise<number> {
  let goalId: string | undefined
  let smokePath: string | undefined
  let outPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--smoke' || a === '--out') {
      const v = args[++i]
      if (v === undefined) {
        io.err(`error: ${a} needs a value\n\n${RUN_HELP}`)
        return 2
      }
      if (a === '--smoke') smokePath = v
      else outPath = v
    } else if (a.startsWith('--') || goalId !== undefined) {
      io.err(`error: unexpected argument "${a}"\n\n${RUN_HELP}`)
      return 2
    } else goalId = a
  }
  if (goalId === undefined) {
    io.err(`error: a goal id is required\n\n${RUN_HELP}`)
    return 2
  }

  let smoke: Smoke | null = null
  if (smokePath !== undefined) {
    let text: string | null = null
    try {
      text = fs.readFileSync(smokePath, 'utf8')
    } catch {
      text = null
    }
    smoke = text === null ? null : parseSmoke(text)
    if (smoke === null) {
      io.err(`smoke file is not valid: ${smokePath}\n`)
      return 3
    }
  }

  const report = await buildRunReport(deps, goalId, smoke)
  if (!report) {
    io.err(`unknown goal: ${goalId}\n`)
    return 2
  }

  let target = outPath
  if (target === undefined) {
    const home = await deps.homeCwd(goalId)
    if (!home) {
      io.err(`error: goal ${goalId} has no home workspace cwd — pass --out\n`)
      return 2
    }
    target = path.join(home, 'docs', 'reports', reportFileName(goalId))
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, renderRunReport(report))
  io.out(`${target}\n`)
  return 0
}

export async function dispatchRun(sub: string | undefined, args: string[]): Promise<number> {
  const io: RunIo = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }
  if (sub !== 'report') {
    io.err(`error: unknown run subcommand "${sub ?? ''}" — only "run report" is supported\n\n${RUN_HELP}`)
    return 2
  }
  const { createCliServices } = await import('./service-factory')
  const { svc } = await createCliServices()
  try {
    return await runReportCommand(args, io, {
      getTask: (id) => svc.getTask(id),
      getSubtasks: (id) => svc.getSubtasks(id),
      findSessions: (projectId) => svc.findSessions(projectId),
      listSessionEvents: (id, type) => svc.listSessionEvents(id, type),
      getRelationshipsFrom: (id, type) => svc.getRelationshipsFrom(id, type),
      getRelationshipsTo: (id, type) => svc.getRelationshipsTo(id, type),
      getProject: (id) => svc.getProject(id),
      getWorkspace: (id) => svc.getWorkspace(id),
      gitShow,
      now: () => new Date().toISOString(),
      homeCwd: async (goalId) => {
        const goal = await svc.getTask(goalId)
        return goal ? ((await svc.getProject(goal.projectId))?.cwd ?? null) : null
      }
    })
  } finally {
    await svc.close()
  }
}
