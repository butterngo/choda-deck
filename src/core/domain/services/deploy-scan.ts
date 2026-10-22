import type { Session, Task } from '../task-types'
import { goalTree } from './run-report'

// TASK-2604 — a goal's deploy checklist, read from what its run changed. Butter,
// 2026-10-21: "phải có luôn cái checklist khi deploy lên là cần phải đảm bảo gì
// vd như chạy migration config a b or c". The diff shows migrations, deploy SQL,
// config keys and routes; the goal's own `## Deploy` section carries what a diff
// cannot (flags, notices to other teams, secret mappings).
//
// Deterministic: the same commits give the same keys in the same order, so a
// re-scan never moves a tick (ticks are stored by key, TASK-2605). No timestamp
// goes into the frontmatter for the same reason.

export type DeployPhase = 'before' | 'deploy' | 'after'
export type DeployKind = 'sql' | 'migration' | 'config' | 'endpoint' | 'manual'

export interface DeploySecretRef {
  file: string
  field: string
}

export interface DeployItem {
  key: string
  phase: DeployPhase
  kind: DeployKind
  title: string
  why: string
  workspaceId: string | null
  file?: string
  copy?: string
  /** Config keys that look secret: the mapping from `## Deploy`, or null = ask Butter. */
  secret?: DeploySecretRef | null
}

export interface DeployScanDeps {
  getTask(id: string): Promise<Task | null>
  getSubtasks(id: string): Promise<Task[]>
  findSessions(projectId: string): Promise<Session[]>
  getProject(id: string): Promise<{ cwd: string } | null>
  getWorkspace(id: string): Promise<{ cwd: string } | null>
  /** `git <args>` in `cwd`; null when git fails (unknown commit, missing path). */
  git(cwd: string, args: string[]): string | null
}

interface Commit {
  sha: string
  cwd: string
  workspaceId: string | null
}

const KIND_ORDER: DeployKind[] = ['sql', 'migration', 'config', 'endpoint', 'manual']
const TEST_PATH = /(^|\/)tests?\/|\.Tests\/|\.test\./
const SQL_PATH = /^(?:.*\/)?docs\/deploy\/sql\/[^/]+\.sql$/
const MIGRATION_PATH = /(^|\/)Migrations\/([^/]+)\.cs$/
const APPSETTINGS = /(^|\/)appsettings[^/]*\.json$/
const CONFIG_READS = [
  /\b\w*[Cc]onfig\w*\[\s*"([^"]+)"\s*\]/g,
  /\bGetSection\(\s*"([^"]+)"/g,
  /\bUseSetting\(\s*"([^"]+)"/g
]
const ENDPOINT = /\bMap(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g
const SECRET_NAME = /key|secret|token|password/i
const MANUAL_LINE = /^\s*-\s*\[(before|deploy|after)\]\s*(.+?)\s*$/
const SECRET_MAP = /^\s*-?\s*secret:\s*(\S+)\s*=\s*(sensitive_information\/[^#\s]+)#(\S+)\s*$/

/** The `## Deploy` section of a goal body, or '' when there is none. */
function deploySection(body: string | null): string {
  return (body ?? '').split(/^## Deploy[^\n]*$/m)[1]?.split(/^## /m)[0] ?? ''
}

export function parseDeploySection(body: string | null): {
  manual: { phase: DeployPhase; text: string }[]
  secrets: Map<string, DeploySecretRef>
} {
  const manual: { phase: DeployPhase; text: string }[] = []
  const secrets = new Map<string, DeploySecretRef>()
  for (const line of deploySection(body).split(/\r?\n/)) {
    const s = SECRET_MAP.exec(line)
    if (s) {
      secrets.set(s[1], { file: s[2], field: s[3] })
      continue
    }
    const m = MANUAL_LINE.exec(line)
    if (m) manual.push({ phase: m[1] as DeployPhase, text: m[2] })
  }
  return { manual, secrets }
}

/** Leaf paths of a JSON object, `:` separated as .NET configuration names them. */
function jsonKeys(text: string | null): Set<string> {
  const out = new Set<string>()
  if (text === null) return out
  let v: unknown
  try {
    // appsettings files may carry // comments, which JSON.parse refuses.
    v = JSON.parse(text.replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return out
  }
  const walk = (node: unknown, prefix: string): void => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [k, child] of Object.entries(node as Record<string, unknown>)) walk(child, prefix ? `${prefix}:${k}` : k)
    } else if (prefix) out.add(prefix)
  }
  walk(v, '')
  return out
}

/** The lines a commit added, per file. */
function addedLines(patch: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let file: string | null = null
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null
      if (file && !out.has(file)) out.set(file, [])
      continue
    }
    if (file && raw.startsWith('+') && !raw.startsWith('+++')) out.get(file)?.push(raw.slice(1))
  }
  return out
}

const helmEnv = (key: string): string => `${key.replace(/:/g, '__')}: "<value>"`

async function goalCommits(deps: DeployScanDeps, goal: Task): Promise<Commit[]> {
  const items = await goalTree(deps, goal.id)
  const ids = new Set(items.map((t) => t.id))
  const project = await deps.getProject(goal.projectId)
  const sessions = (await deps.findSessions(goal.projectId))
    .filter((s) => s.taskId !== null && ids.has(s.taskId))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const cwds = new Map<string, string | null>()
  const seen = new Set<string>()
  const out: Commit[] = []
  for (const s of sessions) {
    for (const raw of s.handoff?.commits ?? []) {
      const sha = raw.split(' ')[0]
      if (!sha || seen.has(sha)) continue
      seen.add(sha)
      const ws = s.workspaceId ?? null
      if (ws && !cwds.has(ws)) cwds.set(ws, (await deps.getWorkspace(ws))?.cwd ?? null)
      const cwd = (ws ? cwds.get(ws) : null) ?? project?.cwd
      if (cwd) out.push({ sha, cwd, workspaceId: ws })
    }
  }
  return out
}

/** Null when the goal does not exist. */
export async function buildDeployChecklist(deps: DeployScanDeps, goalId: string): Promise<DeployItem[] | null> {
  const goal = await deps.getTask(goalId)
  if (!goal) return null
  const { manual, secrets } = parseDeploySection(goal.body)
  const byKey = new Map<string, DeployItem>()
  const add = (item: DeployItem): void => {
    if (!byKey.has(item.key)) byKey.set(item.key, item)
  }
  // Deploy SQL files added by the run, with their text, to find the one naming a migration.
  const sqlTexts: { path: string; text: string }[] = []
  const migrations: { id: string; commit: Commit; path: string }[] = []

  for (const c of await goalCommits(deps, goal)) {
    const status = deps.git(c.cwd, ['show', '--format=', '--name-status', '--no-renames', c.sha])
    if (status === null) continue
    for (const line of status.split(/\r?\n/)) {
      const [code, path] = line.split('\t')
      if (!path || code !== 'A') continue
      if (SQL_PATH.test(path)) {
        const text = deps.git(c.cwd, ['show', `${c.sha}:${path}`]) ?? ''
        sqlTexts.push({ path, text })
        add({
          key: `sql:${path}`,
          phase: 'before',
          kind: 'sql',
          title: `Run ${path.split('/').pop()}`,
          why: `Deploy SQL added by ${c.sha}`,
          workspaceId: c.workspaceId,
          file: path
        })
        continue
      }
      const mig = MIGRATION_PATH.exec(path)
      if (mig && !/\.Designer$|ModelSnapshot$/.test(mig[2])) migrations.push({ id: mig[2], commit: c, path })
    }

    const patch = deps.git(c.cwd, ['show', '--format=', '--no-color', '--no-ext-diff', c.sha]) ?? ''
    for (const [path, lines] of addedLines(patch)) {
      if (TEST_PATH.test(path)) continue
      if (APPSETTINGS.test(path)) {
        const before = jsonKeys(deps.git(c.cwd, ['show', `${c.sha}^:${path}`]))
        for (const key of jsonKeys(deps.git(c.cwd, ['show', `${c.sha}:${path}`]))) {
          if (!before.has(key)) add(configItem(key, `Added to ${path}`, c, secrets))
        }
        continue
      }
      for (const text of lines) {
        for (const re of CONFIG_READS) {
          for (const m of text.matchAll(re)) add(configItem(m[1], `Read by ${path}`, c, secrets))
        }
        for (const m of text.matchAll(ENDPOINT)) {
          const method = m[1].toUpperCase()
          add({
            key: `endpoint:${method} ${m[2]}`,
            phase: 'after',
            kind: 'endpoint',
            title: `Check ${method} ${m[2]} answers`,
            why: `New route in ${path}`,
            workspaceId: c.workspaceId
          })
        }
      }
    }
  }

  for (const m of migrations) {
    const named = sqlTexts.filter((s) => s.text.includes(m.id))
    const file = (named.find((s) => !s.path.endsWith('-all.sql')) ?? named[0])?.path
    add({
      key: `migration:${m.id}`,
      phase: 'before',
      kind: 'migration',
      title: `Apply migration ${m.id}`,
      why: file
        ? `Schema change from ${m.commit.sha}; its SQL is in ${file}`
        : `Schema change from ${m.commit.sha}; no deploy SQL names it — generate the script`,
      workspaceId: m.commit.workspaceId,
      ...(file ? { file } : {})
    })
  }

  manual.forEach((m, i) =>
    add({ key: `manual:${i + 1}`, phase: m.phase, kind: 'manual', title: m.text, why: 'From the goal\'s ## Deploy', workspaceId: null })
  )

  return [...byKey.values()].sort(compareItems)
}

function configItem(key: string, why: string, c: Commit, secrets: Map<string, DeploySecretRef>): DeployItem {
  const item: DeployItem = {
    key: `config:${key}`,
    phase: 'before',
    kind: 'config',
    title: `Set ${key}`,
    why,
    workspaceId: c.workspaceId,
    copy: helmEnv(key)
  }
  if (SECRET_NAME.test(key)) {
    const ref = secrets.get(key) ?? null
    item.secret = ref
    if (!ref) item.why = `${why} — secret, value: ask Butter`
  }
  return item
}

function compareItems(a: DeployItem, b: DeployItem): number {
  const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  if (kind !== 0) return kind
  if (a.kind === 'manual') return Number(a.key.slice(7)) - Number(b.key.slice(7))
  if (a.kind === 'sql') {
    const all = Number(!a.key.endsWith('-all.sql')) - Number(!b.key.endsWith('-all.sql'))
    if (all !== 0) return all
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export function deployChecklistFileName(goalId: string): string {
  return `${goalId.toLowerCase()}-deploy-checklist.md`
}

const PHASE_LABEL: Record<DeployPhase, string> = { before: 'Before deploy', deploy: 'Deploy', after: 'After deploy' }
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function renderDeployChecklist(goalId: string, items: DeployItem[]): string {
  const out = [`---\ngoal: ${JSON.stringify(goalId)}\nitems: ${JSON.stringify(items)}\n---`, '', `# Deploy checklist — ${goalId}`, '']
  if (items.length === 0) out.push('Nothing to deploy: the run added no migration, deploy SQL, config key or route, and the goal has no `## Deploy`.')
  for (const phase of ['before', 'deploy', 'after'] as DeployPhase[]) {
    const rows = items.filter((i) => i.phase === phase)
    if (rows.length === 0) continue
    out.push(`## ${PHASE_LABEL[phase]}`, '', '| Item | Why | File / copy |', '|---|---|---|')
    for (const i of rows) out.push(`| ${cell(i.title)} | ${cell(i.why)} | ${cell(i.file ?? i.copy ?? '—')} |`)
    out.push('')
  }
  return out.join('\n').replace(/\n*$/, '\n')
}

/** TASK-2607 — read a checklist file's items back; null when its frontmatter does not parse. */
export function parseDeployChecklist(text: string): DeployItem[] | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  const line = block?.split(/\r?\n/).find((l) => l.startsWith('items: '))
  if (!line) return null
  try {
    const items = JSON.parse(line.slice(7)) as unknown
    return Array.isArray(items) ? (items as DeployItem[]) : null
  } catch {
    return null
  }
}
