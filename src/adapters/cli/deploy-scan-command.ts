import * as fs from 'fs'
import * as path from 'path'
import { checkoutRootFor } from '../../core/worktree-path'
import { execFileSync } from 'child_process'
import {
  buildDeployChecklist,
  deployChecklistFileName,
  renderDeployChecklist,
  type DeployScanDeps
} from '../../core/domain/services/deploy-scan'

// TASK-2604 — `choda-deck deploy scan <goalId> [--out <path>]`. Writes the goal's
// deploy checklist next to its test report and prints the path. Exit 2 on usage
// errors or an unknown goal.

export const DEPLOY_HELP = `deploy scan <goalId> [--out <path>]
  Build the goal's deploy checklist from its run's commits (deploy SQL,
  migrations, config keys, routes) and its ## Deploy section. Writes
  <goal home workspace>/docs/reports/<goal>-deploy-checklist.md, or --out.
`

export interface DeployIo {
  out(text: string): void
  err(text: string): void
}

export type DeployScanCommandDeps = DeployScanDeps & {
  homeCwd(goalId: string): Promise<string | null>
  /** Where the command runs; defaults to process.cwd(). Picks the worktree to write into. */
  cwd?: () => string
}

export function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024
    })
  } catch {
    return null
  }
}

export async function deployScanCommand(args: string[], io: DeployIo, deps: DeployScanCommandDeps): Promise<number> {
  let goalId: string | undefined
  let outPath: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--out') {
      outPath = args[++i]
      if (outPath === undefined) {
        io.err(`error: --out needs a value\n\n${DEPLOY_HELP}`)
        return 2
      }
    } else if (a.startsWith('--') || goalId !== undefined) {
      io.err(`error: unexpected argument "${a}"\n\n${DEPLOY_HELP}`)
      return 2
    } else goalId = a
  }
  if (goalId === undefined) {
    io.err(`error: a goal id is required\n\n${DEPLOY_HELP}`)
    return 2
  }

  const items = await buildDeployChecklist(deps, goalId)
  if (items === null) {
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
    // TASK-2790 — run from a worktree of the home workspace, write into that worktree.
    target = path.join(checkoutRootFor(home, deps.cwd?.() ?? process.cwd()), 'docs', 'reports', deployChecklistFileName(goalId))
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, renderDeployChecklist(goalId, items))
  io.out(`${target}\n`)
  return 0
}

export async function dispatchDeploy(sub: string | undefined, args: string[]): Promise<number> {
  const io: DeployIo = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) }
  if (sub !== 'scan') {
    io.err(`error: unknown deploy subcommand "${sub ?? ''}" — only "deploy scan" is supported\n\n${DEPLOY_HELP}`)
    return 2
  }
  const { createCliServices } = await import('./service-factory')
  const { svc } = await createCliServices()
  try {
    return await deployScanCommand(args, io, {
      getTask: (id) => svc.getTask(id),
      getSubtasks: (id) => svc.getSubtasks(id),
      findSessions: (projectId) => svc.findSessions(projectId),
      getProject: (id) => svc.getProject(id),
      getWorkspace: (id) => svc.getWorkspace(id),
      git,
      homeCwd: async (goalId) => {
        const goal = await svc.getTask(goalId)
        return goal ? ((await svc.getProject(goal.projectId))?.cwd ?? null) : null
      }
    })
  } finally {
    await svc.close()
  }
}
