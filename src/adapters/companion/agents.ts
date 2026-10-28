import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'
import { listAttention, workspaceForCwd } from './attention'
import { cwdToProjectSlug } from '../../core/domain/session-transcript'

// TASK-2855 — the Claude Code sessions running on this laptop, for the Runs
// screen and the assistant (goal TASK-2854, discovery CONV-1793202011707-3).
//
// Claude Code keeps one file per live session in ~/.claude/sessions/<pid>.json
// (pid, sessionId, cwd, name, kind, status, procStart, statusUpdatedAt). The
// format is undocumented, so a file that does not parse is counted in
// `unreadable`, never a 500. A file can outlive its process (a crash) and a
// pid can be reused, so a session is listed only when its pid is alive AND the
// process started at `procStart` — a Windows FILETIME, verified equal to
// (Get-Process).StartTime.ToFileTimeUtc() on Claude Code 2.1.309.
//
// The attention hook's waiting/finished state overrides the registry's
// busy/idle, and the transcript tail gives the last activity and the last tool.
// Read-only and local, so GET without the bridge token, like /attention.

export interface Agent {
  sessionId: string
  pid: number
  name: string
  cwd: string
  workspaceId: string | null
  kind: string
  status: string
  since: string | null
  lastActivityAt: string | null
  lastTool: string | null
  subagents: number
}

export interface AgentsResult {
  agents: Agent[]
  unreadable: number
}

export interface AgentsDeps {
  /** Unset → no attention overrides. */
  dataDir?: string
  workspaces: () => Promise<{ id: string; cwd: string }[]>
  /** Defaults to os.homedir(). */
  homeDir?: string
  /** pid → process start as a FILETIME string; a pid missing from the map is not running. */
  readStartTimes?: (pids: number[]) => Promise<Map<number, string>>
  now?: () => number
}

interface RegistryFile {
  pid: number
  sessionId: string
  cwd?: string
  name?: string
  kind?: string
  status?: string
  procStart?: string
  statusUpdatedAt?: number
}

// The transcript can be many MB; the tail holds everything this route reads.
const TAIL_BYTES = 256 * 1024
const START_TIMES_TIMEOUT_MS = 3000

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const len = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/** Last row time, last tool the assistant called, from the transcript tail. */
export function transcriptActivity(content: string): {
  lastActivityAt: string | null
  lastTool: string | null
} {
  let lastActivityAt: string | null = null
  let lastTool: string | null = null
  // The first line of a tail read is usually cut mid-row; JSON.parse drops it.
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: { type?: string; timestamp?: string; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof row.timestamp === 'string') lastActivityAt = row.timestamp
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content as { type?: string; name?: string }[]) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') lastTool = block.name
    }
  }
  return { lastActivityAt, lastTool }
}

function sessionTranscript(
  homeDir: string,
  cwd: string,
  sessionId: string
): { lastActivityAt: string | null; lastTool: string | null; subagents: number } {
  const base = path.join(homeDir, '.claude', 'projects', cwdToProjectSlug(cwd))
  let activity: { lastActivityAt: string | null; lastTool: string | null } = {
    lastActivityAt: null,
    lastTool: null
  }
  try {
    activity = transcriptActivity(readTail(path.join(base, `${sessionId}.jsonl`)))
  } catch {
    // No transcript yet (a session that has not written one) — leave nulls.
  }
  let subagents = 0
  try {
    subagents = fs.readdirSync(path.join(base, sessionId, 'subagents')).length
  } catch {
    // No subagents dir.
  }
  return { ...activity, subagents }
}

function parseRegistry(raw: string): RegistryFile | null {
  const v = JSON.parse(raw) as Partial<RegistryFile>
  if (typeof v.pid !== 'number' || typeof v.sessionId !== 'string') return null
  return v as RegistryFile
}

/** One PowerShell call for every pid; dead pids are simply absent. */
export function readStartTimesWindows(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (pids.length === 0) return Promise.resolve(out)
  const script =
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }`
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    let stdout = ''
    const timer = setTimeout(() => child.kill(), START_TIMES_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.on('close', () => {
      clearTimeout(timer)
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^(\d+) (\d+)$/.exec(line.trim())
        if (m) out.set(Number(m[1]), m[2])
      }
      resolve(out)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

export async function listAgents(deps: AgentsDeps): Promise<AgentsResult> {
  const homeDir = deps.homeDir ?? os.homedir()
  const dir = path.join(homeDir, '.claude', 'sessions')
  let names: string[]
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    return { agents: [], unreadable: 0 }
  }

  let unreadable = 0
  const entries: RegistryFile[] = []
  for (const n of names) {
    try {
      const entry = parseRegistry(fs.readFileSync(path.join(dir, n), 'utf8'))
      if (entry) entries.push(entry)
      else unreadable += 1
    } catch {
      unreadable += 1
    }
  }

  const readStartTimes = deps.readStartTimes ?? readStartTimesWindows
  const started = await readStartTimes(entries.map((e) => e.pid))
  const live = entries.filter((e) => {
    const start = started.get(e.pid)
    // A reused pid runs, but not the process that wrote this file.
    return start !== undefined && (e.procStart === undefined || e.procStart === start)
  })

  const workspaces = await deps.workspaces()
  const attention = new Map(
    (await listAttention({ dataDir: deps.dataDir, workspaces: async () => workspaces, now: deps.now })).map(
      (a) => [a.sessionId, a]
    )
  )

  const agents = live.map((e): Agent => {
    const cwd = e.cwd ?? ''
    const att = attention.get(e.sessionId)
    return {
      sessionId: e.sessionId,
      pid: e.pid,
      name: e.name ?? e.sessionId,
      cwd,
      workspaceId: workspaceForCwd(cwd, workspaces),
      kind: e.kind ?? 'unknown',
      status: att ? att.state : (e.status ?? 'unknown'),
      since: att
        ? att.since
        : typeof e.statusUpdatedAt === 'number'
          ? new Date(e.statusUpdatedAt).toISOString()
          : null,
      ...sessionTranscript(homeDir, cwd, e.sessionId)
    }
  })
  agents.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
  return { agents, unreadable }
}

/** Returns true when it handled the request. */
export async function handleAgentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AgentsDeps
): Promise<boolean> {
  if ((req.url ?? '/').split('?')[0] !== '/agents' || req.method !== 'GET') return false
  try {
    const result = await listAgents(deps)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: (err as Error).message }))
  }
  return true
}
