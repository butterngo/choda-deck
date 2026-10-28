import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'
import { redact } from '../assistant/redact'

// TASK-2856 — what runs for a workspace: processes, memory, listening ports,
// and the ports its .NET projects are declared to listen on (goal TASK-2854,
// discovery CONV-1793202011707-3). A smoke that waits on a service — INBOX-2337
// waited on ChatEngine's 5267 — shows here as an expected port nobody listens on.
//
// One PowerShell child reads Win32_Process and the TCP listen table (measured
// 0.7 s and 2.3 s). It runs asynchronously under OUR 5 s timer, the pattern of
// docker-actions.ts: a synchronous read would freeze the adapter, and a child
// is never trusted to honour its own timeout. The snapshot is machine-wide, so
// one is cached for 10 s and shared by every workspace.
//
// Command lines carry keys and passwords, so each goes through redact() before
// it leaves the route. Read-only and local: GET without the bridge token.

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
  cmdline: string
  memoryMb: number
  ports: number[]
}

export interface ExpectedPort {
  port: number
  project: string
  listening: boolean
}

export interface RawSnapshot {
  processes: { pid: number; ppid: number; name: string; cmdline: string; workingSet: number }[]
  listeners: { pid: number; port: number }[]
}

/** The child the route spawns — narrowed so a test can hand in a fake. */
export interface ListerChild {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  on(event: 'close' | 'error', cb: () => void): unknown
  kill(): unknown
}

export interface ProcessesDeps {
  spawnLister?: () => ListerChild
  now?: () => number
}

export type FindWorkspace = (id: string) => Promise<{ id: string; cwd: string } | null>

export const LISTER_TIMEOUT_MS = 5000
export const CACHE_MS = 10_000
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', '.git'])
const MAX_DEPTH = 6

const LISTER_SCRIPT = [
  '$p = Get-CimInstance Win32_Process | ForEach-Object {',
  '  @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name;',
  '     cmdline = [string]$_.CommandLine; workingSet = [double]$_.WorkingSetSize } }',
  '$l = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {',
  '  @{ pid = [int]$_.OwningProcess; port = [int]$_.LocalPort } }',
  '@{ processes = @($p); listeners = @($l) } | ConvertTo-Json -Compress -Depth 3'
].join('\n')

const spawnPowerShell = (): ListerChild =>
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', LISTER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true
  })

/** Runs the lister under our own timer. `null` = timed out (the child was killed). */
export function runLister(spawnLister: () => ListerChild): Promise<RawSnapshot | null> {
  return new Promise((resolve, reject) => {
    const child = spawnLister()
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve(null)
    }, LISTER_TIMEOUT_MS)
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('process lister failed to start'))
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        const raw = JSON.parse(out) as Partial<RawSnapshot>
        resolve({ processes: raw.processes ?? [], listeners: raw.listeners ?? [] })
      } catch {
        reject(new Error('process lister returned unreadable output'))
      }
    })
  })
}

const norm = (p: string): string => p.replace(/\//g, '\\').toLowerCase()

/**
 * True when the command line names the workspace's cwd or one of its run
 * worktrees. A bare substring test would put C:\dev\choda-deck-companion's
 * processes under C:\dev\choda-deck, so the cwd must end at a path boundary.
 */
export function cmdlineInWorkspace(cmdline: string, cwd: string): boolean {
  const root = norm(cwd).replace(/\\+$/, '')
  const text = norm(cmdline)
  let at = text.indexOf(root)
  while (at >= 0) {
    const next = text.slice(at + root.length)
    if (next === '' || /^[\\"' ]/.test(next) || next.startsWith('.worktrees\\')) return true
    at = text.indexOf(root, at + 1)
  }
  return false
}

function portsFromUrls(urls: string): number[] {
  const ports: number[] = []
  for (const u of urls.split(';')) {
    try {
      const url = new URL(u.trim())
      const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      if (Number.isInteger(port) && port > 0) ports.push(port)
    } catch {
      // Not a URL (e.g. a variable) — nothing to expect.
    }
  }
  return ports
}

/** Every `applicationUrl` port in `**\/Properties/launchSettings.json` under the workspace. */
export function declaredPorts(cwd: string): { port: number; project: string }[] {
  const out = new Map<number, string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const sub = path.join(dir, e.name)
      if (e.name === 'Properties') {
        try {
          const settings = JSON.parse(
            fs.readFileSync(path.join(sub, 'launchSettings.json'), 'utf8')
          ) as { profiles?: Record<string, { applicationUrl?: string }> }
          for (const profile of Object.values(settings.profiles ?? {})) {
            for (const port of portsFromUrls(profile?.applicationUrl ?? '')) {
              if (!out.has(port)) out.set(port, path.basename(dir))
            }
          }
        } catch {
          // No launchSettings.json, or one that does not parse.
        }
        continue
      }
      walk(sub, depth + 1)
    }
  }
  walk(cwd, 0)
  return [...out].map(([port, project]) => ({ port, project })).sort((a, b) => a.port - b.port)
}

/** One route instance per adapter process, so the 10 s cache is shared by every request. */
export function createProcessesRoute(
  deps: ProcessesDeps = {}
): (req: IncomingMessage, res: ServerResponse, findWorkspace: FindWorkspace) => Promise<boolean> {
  const spawnLister = deps.spawnLister ?? spawnPowerShell
  const now = deps.now ?? Date.now
  let cache: { at: number; snapshot: RawSnapshot } | null = null

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  return async (req, res, findWorkspace) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/processes' || req.method !== 'GET') return false
    try {
      const ws = await findWorkspace(url.searchParams.get('workspaceId') ?? '')
      if (!ws) {
        send(res, 404, { error: 'unknown workspace' })
        return true
      }
      if (!cache || now() - cache.at >= CACHE_MS) {
        const snapshot = await runLister(spawnLister)
        if (!snapshot) {
          send(res, 504, { error: 'process list timed out' })
          return true
        }
        cache = { at: now(), snapshot }
      }
      const { processes, listeners } = cache.snapshot
      const portsByPid = new Map<number, number[]>()
      for (const l of listeners) {
        const list = portsByPid.get(l.pid) ?? []
        if (!list.includes(l.port)) list.push(l.port)
        portsByPid.set(l.pid, list)
      }
      const rows: ProcessRow[] = processes
        .filter((p) => p.cmdline && cmdlineInWorkspace(p.cmdline, ws.cwd))
        .map((p) => ({
          pid: p.pid,
          ppid: p.ppid,
          name: p.name,
          cmdline: redact(p.cmdline),
          memoryMb: Math.round(p.workingSet / (1024 * 1024)),
          ports: (portsByPid.get(p.pid) ?? []).sort((a, b) => a - b)
        }))
      const listening = new Set(listeners.map((l) => l.port))
      const expectedPorts: ExpectedPort[] = declaredPorts(ws.cwd).map((d) => ({
        ...d,
        listening: listening.has(d.port)
      }))
      send(res, 200, { processes: rows, expectedPorts })
    } catch (err) {
      send(res, 500, { error: (err as Error).message })
    }
    return true
  }
}
