import { splitLines } from '../../utils/lines'

// TASK-2150 — the pure half of the daily activity digest (TASK-2149).
// Takes raw Claude Code transcript JSONL contents plus the registered workspace
// cwds and returns the transcript-derived metrics for ONE local date. No FS, git
// or DB here: the CLI (TASK-2151) gathers inputs and fills the fields this module
// leaves at zero (historyRows, skippedRepos, sessionsCompleted, mergesToDefault).
//
// The transcript jsonl is an undocumented Claude Code format, so metrics key only
// on `user`/`assistant` rows; every other type is counted, never interpreted.

export const DEFAULT_TZ = 'Asia/Ho_Chi_Minh'

const BUCKET_MS = 5 * 60_000
const CONFIRMATION = /^(ok(ay)?|oke|y(es)?|ừ|rồi|được|đúng|go|tiếp|[0-9])\W*$/i
const MIN_REPEATED_LENGTH = 10
const MAX_REPEATED = 20

export interface ActivitySources {
  transcriptFiles: number
  rows: number
  badRows: number
  unknownTypes: number
  historyRows: number
  skippedRepos: number
}

export interface ProjectActivity {
  workspace: string
  prompts: number
  activeMinutes: number
  tokens: number
}

export interface ActivityMetrics {
  prompts: number
  confirmationTurns: number
  confirmationRate: number
  claudeRunMinutes: number
  waitMinutes: number
  activeMinutes: number
  projectSwitches: number
  switchesPerActiveHour: number
  unresolvedPrompts: number
  parallelSessionsPeak: number
  sessionsCompleted: number
  mergesToDefault: number
  toolMix: Record<string, number>
  toolDenials: number
  skillsUsed: Record<string, number>
  tokens: { in: number; out: number; cacheRead: number }
  byProject: ProjectActivity[]
  repeatedPrompts: { normalized: string; count: number }[]
}

export interface ActivityDigest {
  date: string
  tz: string
  generatedAt: string
  claudeCodeVersions: string[]
  sources: ActivitySources
  metrics: ActivityMetrics
}

export interface TranscriptDigestInput {
  /** Local calendar date, YYYY-MM-DD, in `tz`. */
  date: string
  tz?: string
  /** Raw JSONL content of each transcript file. */
  files: string[]
  /** Registered workspace cwds — prompts are attributed by longest prefix. */
  workspaces: string[]
}

export type TranscriptDigest = Pick<ActivityDigest, 'claudeCodeVersions' | 'sources' | 'metrics'>

interface Row {
  type?: unknown
  timestamp?: unknown
  sessionId?: unknown
  cwd?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  version?: unknown
  toolDenialKind?: unknown
  attributionSkill?: unknown
  message?: { content?: unknown; usage?: Record<string, unknown> }
}

interface Prompt {
  t: number
  session: string
  workspace: string
  resolved: boolean
  text: string
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

/** YYYY-MM-DD of an instant in `tz`. */
export function localDate(ms: number, tz: string): string {
  let fmt = dateFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    dateFormatters.set(tz, fmt)
  }
  return fmt.format(ms)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Longest registered prefix, or null when the cwd belongs to no workspace. */
export function resolveWorkspace(cwd: string, workspaces: string[]): string | null {
  const c = normalizePath(cwd)
  let best: string | null = null
  for (const w of workspaces) {
    const n = normalizePath(w)
    if ((c === n || c.startsWith(n + '/')) && (best === null || n.length > best.length)) best = n
  }
  return best
}

function blocks(content: unknown): { type?: unknown; text?: unknown; name?: unknown }[] {
  return Array.isArray(content) ? (content as { type?: unknown }[]) : []
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content
  const bs = blocks(content)
  if (bs.some((b) => b.type === 'tool_result')) return null
  const text = bs.find((b) => b.type === 'text' && typeof b.text === 'string')
  return text ? (text.text as string) : null
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function round(v: number, places: number): number {
  const f = 10 ** places
  return Math.round(v * f) / f
}

function sortedRecord(r: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...r.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function bump(m: Map<string, number>, key: string, by = 1): void {
  m.set(key, (m.get(key) ?? 0) + by)
}

export function computeTranscriptDigest(input: TranscriptDigestInput): TranscriptDigest {
  const tz = input.tz ?? DEFAULT_TZ
  const sources: ActivitySources = {
    transcriptFiles: input.files.length,
    rows: 0,
    badRows: 0,
    unknownTypes: 0,
    historyRows: 0,
    skippedRepos: 0
  }
  const versions = new Set<string>()
  const prompts: Prompt[] = []
  const assistantTimes = new Map<string, number[]>()
  const buckets = new Set<number>()
  const bucketSessions = new Map<number, Set<string>>()
  const projectBuckets = new Map<string, Set<number>>()
  const projectTokens = new Map<string, number>()
  const toolMix = new Map<string, number>()
  const skills = new Map<string, number>()
  const tokens = { in: 0, out: 0, cacheRead: 0 }
  let toolDenials = 0

  const attribute = (cwd: unknown): { workspace: string; resolved: boolean } => {
    const raw = typeof cwd === 'string' ? cwd : ''
    const ws = resolveWorkspace(raw, input.workspaces)
    return ws
      ? { workspace: ws, resolved: true }
      : { workspace: normalizePath(raw), resolved: false }
  }
  const markActive = (t: number, session: string, workspace: string): void => {
    const b = Math.floor(t / BUCKET_MS)
    buckets.add(b)
    let s = bucketSessions.get(b)
    if (!s) bucketSessions.set(b, (s = new Set()))
    s.add(session)
    let p = projectBuckets.get(workspace)
    if (!p) projectBuckets.set(workspace, (p = new Set()))
    p.add(b)
  }

  for (const file of input.files) {
    for (const line of splitLines(file)) {
      if (!line.trim()) continue
      let row: Row
      try {
        row = JSON.parse(line) as Row
      } catch {
        sources.badRows++
        continue
      }
      if (typeof row.timestamp !== 'string') continue
      const t = Date.parse(row.timestamp)
      if (Number.isNaN(t) || localDate(t, tz) !== input.date) continue
      sources.rows++
      if (row.type !== 'user' && row.type !== 'assistant') {
        sources.unknownTypes++
        continue
      }
      if (typeof row.version === 'string') versions.add(row.version)
      if (row.toolDenialKind) toolDenials++
      if (typeof row.attributionSkill === 'string') bump(skills, row.attributionSkill)
      const session = typeof row.sessionId === 'string' ? row.sessionId : ''
      const sidechain = row.isSidechain === true
      const content = row.message?.content

      if (row.type === 'assistant') {
        for (const b of blocks(content)) {
          if (b.type === 'tool_use' && typeof b.name === 'string') bump(toolMix, b.name)
        }
        const usage = row.message?.usage
        const used = num(usage?.input_tokens) + num(usage?.cache_creation_input_tokens)
        tokens.in += used
        tokens.out += num(usage?.output_tokens)
        tokens.cacheRead += num(usage?.cache_read_input_tokens)
        const { workspace } = attribute(row.cwd)
        bump(projectTokens, workspace, used + num(usage?.output_tokens))
        if (!sidechain) {
          let times = assistantTimes.get(session)
          if (!times) assistantTimes.set(session, (times = []))
          times.push(t)
          markActive(t, session, workspace)
        }
        continue
      }

      if (sidechain || row.isMeta === true) continue
      const text = promptText(content)
      if (text === null) continue
      const { workspace, resolved } = attribute(row.cwd)
      prompts.push({ t, session, workspace, resolved, text })
      markActive(t, session, workspace)
    }
  }

  prompts.sort((a, b) => a.t - b.t)

  // claudeRun: prompt → last main-thread assistant row of the same session before
  // that session's next prompt. wait: a run during which no other session got a prompt.
  let runMs = 0
  let waitMs = 0
  for (const p of prompts) {
    const next = prompts.find((q) => q.session === p.session && q.t > p.t)?.t ?? Infinity
    const ends = (assistantTimes.get(p.session) ?? []).filter((t) => t > p.t && t < next)
    if (ends.length === 0) continue
    const end = Math.max(...ends)
    runMs += end - p.t
    if (!prompts.some((o) => o.session !== p.session && o.t > p.t && o.t < end)) waitMs += end - p.t
  }

  let switches = 0
  for (let i = 1; i < prompts.length; i++) {
    if (prompts[i].workspace !== prompts[i - 1].workspace) switches++
  }

  const confirmationTurns = prompts.filter((p) => CONFIRMATION.test(p.text.trim())).length
  const activeMinutes = buckets.size * 5

  const repeated = new Map<string, number>()
  for (const p of prompts) {
    const n = p.text.trim().replace(/\s+/g, ' ').toLowerCase()
    if (n.length >= MIN_REPEATED_LENGTH) bump(repeated, n)
  }

  const projectPrompts = new Map<string, number>()
  for (const p of prompts) bump(projectPrompts, p.workspace)
  const projectNames = new Set([...projectPrompts.keys(), ...projectBuckets.keys()])

  return {
    claudeCodeVersions: [...versions].sort(),
    sources,
    metrics: {
      prompts: prompts.length,
      confirmationTurns,
      confirmationRate: prompts.length ? round(confirmationTurns / prompts.length, 2) : 0,
      claudeRunMinutes: round(runMs / 60_000, 1),
      waitMinutes: round(waitMs / 60_000, 1),
      activeMinutes,
      projectSwitches: switches,
      switchesPerActiveHour: activeMinutes ? round(switches / (activeMinutes / 60), 1) : 0,
      unresolvedPrompts: prompts.filter((p) => !p.resolved).length,
      parallelSessionsPeak: Math.max(0, ...[...bucketSessions.values()].map((s) => s.size)),
      sessionsCompleted: 0,
      mergesToDefault: 0,
      toolMix: sortedRecord(toolMix),
      toolDenials,
      skillsUsed: sortedRecord(skills),
      tokens,
      byProject: [...projectNames]
        .map((workspace) => ({
          workspace,
          prompts: projectPrompts.get(workspace) ?? 0,
          activeMinutes: (projectBuckets.get(workspace)?.size ?? 0) * 5,
          tokens: projectTokens.get(workspace) ?? 0
        }))
        .sort((a, b) => b.prompts - a.prompts || a.workspace.localeCompare(b.workspace)),
      repeatedPrompts: [...repeated.entries()]
        .filter(([, count]) => count >= 2)
        .map(([normalized, count]) => ({ normalized, count }))
        .sort((a, b) => b.count - a.count || a.normalized.localeCompare(b.normalized))
        .slice(0, MAX_REPEATED)
    }
  }
}
