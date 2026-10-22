import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { SqliteTaskService } from '../../core/domain/sqlite-task-service'
import { parseDeployChecklist, type DeployItem } from '../../core/domain/services/deploy-scan'
import { deployScanCommand, git, type DeployScanCommandDeps } from './deploy-scan-command'

// TASK-2604 — `choda-deck deploy scan` against a real SQLite service and a real
// git repo holding the run's commits.

let tmp: string
let home: string
let repo: string
let svc: SqliteTaskService
let err: string

const io = {
  out: (): void => undefined,
  err: (t: string): void => {
    err += t
  }
}

function deps(): DeployScanCommandDeps {
  return {
    getTask: (id) => svc.getTask(id),
    getSubtasks: (id) => svc.getSubtasks(id),
    findSessions: (p) => svc.findSessions(p),
    getProject: (id) => svc.getProject(id),
    getWorkspace: (id) => svc.getWorkspace(id),
    git,
    homeCwd: async () => home
  }
}

const run = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim()

/** Writes the files and commits them; returns the short sha. */
function commit(files: Record<string, string>): string {
  for (const [p, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true })
    fs.writeFileSync(path.join(repo, p), text)
  }
  run('add', '.')
  run('commit', '-q', '-m', 'item (TASK-11)')
  return run('rev-parse', '--short', 'HEAD')
}

const MIG = '20261019101204_ApprovalResults'

function runCommit(): string {
  return commit({
    [`src/Infra/Migrations/${MIG}.cs`]: 'public partial class ApprovalResults : Migration {}\n',
    [`src/Infra/Migrations/${MIG}.Designer.cs`]: 'partial class ApprovalResults {}\n',
    'src/Infra/Migrations/AppDbContextModelSnapshot.cs': 'class Snap {}\n',
    'docs/deploy/sql/approval-results.sql': `-- ${MIG}\nCREATE TABLE approval_results (id uuid);\n`,
    'docs/deploy/sql/a-other.sql': 'SELECT 1;\n',
    'docs/deploy/sql/x-all.sql': `-- everything, incl. ${MIG}\n`,
    'src/Api/ApprovalEndpoints.cs': [
      'var baseUrl = config["Platform:BaseUrl"];',
      'var key = config["ServiceAuth:OutboundKeys:platform"];',
      'group.MapPost("/records/{id:guid}/approval-result", Handle);',
      ''
    ].join('\n')
  })
}

async function goal(body = '## Context\n\nx\n'): Promise<void> {
  await svc.createTask({ id: 'TASK-10', projectId: 'p', title: 'Goal', status: 'READY', body })
  await svc.createTask({ id: 'TASK-11', projectId: 'p', parentTaskId: 'TASK-10', title: 'Item' })
}

async function session(sha: string): Promise<void> {
  const s = await svc.createSession({ projectId: 'p', workspaceId: 'be', taskId: 'TASK-11', startedAt: '2026-10-21T08:00:00.000Z' })
  await svc.updateSession(s.id, { status: 'completed', endedAt: '2026-10-21T08:10:00.000Z', handoff: { commits: [`${sha} item (TASK-11)`] } })
}

const file = (): string => path.join(home, 'docs', 'reports', 'task-10-deploy-checklist.md')

async function scan(): Promise<DeployItem[]> {
  expect(await deployScanCommand(['TASK-10'], io, deps())).toBe(0)
  return parseDeployChecklist(fs.readFileSync(file(), 'utf8')) ?? []
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-scan-'))
  home = path.join(tmp, 'home')
  repo = path.join(tmp, 'bpa-engine')
  fs.mkdirSync(home)
  fs.mkdirSync(repo)
  run('init', '-q', '-b', 'main')
  run('commit', '-q', '--allow-empty', '-m', 'root')
  svc = new SqliteTaskService(path.join(tmp, 'test.db'))
  await svc.ensureProject('p', 'P', home)
  await svc.addWorkspace('p', 'be', 'BE', repo)
  err = ''
})

afterEach(async () => {
  await svc.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('choda-deck deploy scan', () => {
  it('AC-1: an unknown goal returns exit code 2', async () => {
    expect(await deployScanCommand(['TASK-999'], io, deps())).toBe(2)
    expect(err).toContain('unknown goal: TASK-999')
  })

  it('AC-2: a migration plus its Designer and the snapshot yields exactly one migration item', async () => {
    await goal()
    await session(runCommit())
    const migrations = (await scan()).filter((i) => i.kind === 'migration')
    expect(migrations.map((i) => i.key)).toEqual([`migration:${MIG}`])
  })

  it('AC-3: the migration file is the deploy SQL that names its id (not the -all bundle)', async () => {
    await goal()
    await session(runCommit())
    const mig = (await scan()).find((i) => i.key === `migration:${MIG}`)
    expect(mig?.file).toBe('docs/deploy/sql/approval-results.sql')
  })

  it('AC-4: an added *-all.sql is the first sql item', async () => {
    await goal()
    await session(runCommit())
    const sql = (await scan()).filter((i) => i.kind === 'sql')
    expect(sql[0].key).toBe('sql:docs/deploy/sql/x-all.sql')
    expect(sql).toHaveLength(3)
  })

  it('AC-5: config["Platform:BaseUrl"] in src/ yields a config item with the Helm env line', async () => {
    await goal()
    await session(runCommit())
    const item = (await scan()).find((i) => i.key === 'config:Platform:BaseUrl')
    expect(item?.copy).toBe('Platform__BaseUrl: "<value>"')
    expect(item?.phase).toBe('before')
  })

  it('AC-6: the same line under tests/ yields no config item', async () => {
    await goal()
    await session(commit({ 'tests/Api.Tests/ApprovalTests.cs': 'var baseUrl = config["Platform:BaseUrl"];\n' }))
    expect((await scan()).filter((i) => i.kind === 'config')).toEqual([])
  })

  it('AC-7: a secret-looking key with no ## Deploy mapping has secret null and says ask Butter', async () => {
    await goal()
    await session(runCommit())
    const item = (await scan()).find((i) => i.key === 'config:ServiceAuth:OutboundKeys:platform')
    expect(item?.secret).toBeNull()
    expect(item?.why).toContain('ask Butter')
  })

  it('a ## Deploy secret mapping fills secret { file, field }', async () => {
    await goal('## Deploy\n\n- secret: ServiceAuth:OutboundKeys:platform = sensitive_information/service-auth-keys.txt#platform\n')
    await session(runCommit())
    const item = (await scan()).find((i) => i.key === 'config:ServiceAuth:OutboundKeys:platform')
    expect(item?.secret).toEqual({ file: 'sensitive_information/service-auth-keys.txt', field: 'platform' })
  })

  it('AC-8: group.MapPost(...) yields an endpoint item', async () => {
    await goal()
    await session(runCommit())
    const item = (await scan()).find((i) => i.kind === 'endpoint')
    expect(item?.key).toBe('endpoint:POST /records/{id:guid}/approval-result')
    expect(item?.phase).toBe('after')
  })

  it('AC-9: a ## Deploy line "- [after] tell LEX the contract is live" yields a manual after item', async () => {
    await goal('## Context\n\nx\n\n## Deploy\n\n- [after] tell LEX the contract is live\n\n## Acceptance\n')
    const manual = (await scan()).filter((i) => i.kind === 'manual')
    expect(manual).toEqual([
      expect.objectContaining({ key: 'manual:1', phase: 'after', title: 'tell LEX the contract is live' })
    ])
  })

  it('AC-10: two runs on the same fixture write byte-identical frontmatter', async () => {
    await goal('## Deploy\n\n- [before] turn the flag on\n')
    await session(runCommit())
    await scan()
    const first = fs.readFileSync(file(), 'utf8')
    await scan()
    expect(fs.readFileSync(file(), 'utf8')).toBe(first)
  })

  it('an appsettings key added by the commit is a config item', async () => {
    commit({ 'src/Api/appsettings.json': '{ "Old": { "A": 1 } }\n' })
    await goal()
    await session(commit({ 'src/Api/appsettings.json': '{\n  // comment\n  "Old": { "A": 1 },\n  "Events": { "Workspaces": [] }\n}\n' }))
    const config = (await scan()).filter((i) => i.kind === 'config').map((i) => i.key)
    expect(config).toEqual(['config:Events:Workspaces'])
  })
})
