// TASK-2357 — the improve loop's companion routes (epic TASK-2352).
//
//   GET  /improve/:ws                                  config + 14 days of scorecards + runs + rejected + today's proposals
//   PUT  /improve/:ws/config                           validate (TASK-2353), then write .choda/improve.json atomically
//   POST /improve/:ws/run                              spawn `claude -p "/improve-loop <ws>"` detached → 202 { runId }
//   GET  /improve/:ws/runs/:runId                      that run's status + log
//   POST /improve/:ws/proposals/:inboxId/approve       inbox item → task in the item's project
//   POST /improve/:ws/proposals/:inboxId/reject        { reason } → rejected.json + archive the inbox item
//   GET  /improve/:ws/screenshots/<file>               a PNG from that workspace's improve folder only
//
// Data lives in <artifactsDir>/improve/<ws>/ — local files, outside every sync
// path, like the activity digests; only the inbox items sync. Changing `mode`
// writes the config file and nothing else: the one scheduled task (TASK-2361)
// reads the file, so this route never touches Task Scheduler.
//
// Token-gated like workspace-docs: these routes write a user's repo file and
// start a process that spends tokens. Matched on the RAW url so a traversal in
// the screenshot path is refused rather than normalised away by `new URL()`.

import * as fs from 'fs'
import * as path from 'path'
import { Buffer } from 'buffer'
import { randomUUID, timingSafeEqual } from 'crypto'
import { spawn } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'
import type { WorkspaceOperations } from '../../core/domain/interfaces/workspace-repository.interface'
import type { InboxOperations } from '../../core/domain/interfaces/inbox-repository.interface'
import type { InboxLifecycleOperations } from '../../core/domain/interfaces/inbox-lifecycle.interface'
import {
  ImproveConfigError,
  loadImproveConfig,
  saveImproveConfig,
  validateImproveConfig
} from '../../core/domain/improve/improve-config'
import { safeResolve } from './workspace-docs'

const PREFIX = '/improve/'
export const SCORECARD_DAYS = 14
const MAX_BODY_BYTES = 256 * 1024
const MAX_LOG_BYTES = 256 * 1024
const WS_ID = /^[A-Za-z0-9._-]+$/
const PNG = /\.png$/i

/** The tools a headless improve run may use — mirrors the scheduled task (TASK-2361). */
export const RUN_ALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Glob',
  'Task',
  'mcp__choda-tasks__inbox_add',
  'mcp__choda-tasks__inbox_list'
]

export interface RejectedIdea {
  inboxId: string
  reason: string
  at: string
  /** The proposal text, so the skill can skip ideas that come back reworded. */
  content: string
}

export interface ImproveRun {
  runId: string
  ws: string
  startedAt: string
  endedAt: string | null
  exitCode: number | null
}

export interface RunHandle {
  onExit(cb: (code: number | null) => void): void
}

/** Starts the headless run; injected so tests never launch Claude. */
export type RunSpawner = (args: { ws: string; model: string; logFile: string }) => RunHandle

export interface ImproveRouteDeps {
  svc: WorkspaceOperations & Pick<InboxOperations, 'findInbox'> & InboxLifecycleOperations
  bridgeToken: string
  artifactsDir?: string
  spawnRun?: RunSpawner
  now?: () => Date
}

/** ws → runId of the run in flight. One per workspace; module-level so it spans requests. */
const activeRuns = new Map<string, string>()

/** Test hook — the map outlives a single server in a test file. */
export function resetActiveRuns(): void {
  activeRuns.clear()
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0) return false
  const provided = Buffer.from(header, 'utf8')
  const expectedBuf = Buffer.from(expected, 'utf8')
  if (provided.length !== expectedBuf.length) return false
  return timingSafeEqual(provided, expectedBuf)
}

async function readJson(
  req: IncomingMessage
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const c of req) {
    total += (c as Buffer).length
    if (total > MAX_BODY_BYTES) return { ok: false }
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

export function improveDir(artifactsDir: string, ws: string): string {
  return path.join(artifactsDir, 'improve', ws)
}

export function proposalTag(ws: string): string {
  return `[improve:${ws}]`
}

function readJsonFile<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Scorecards written by `choda-deck improve measure` (TASK-2356), newest last. */
function readScorecards(dir: string): unknown[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
    .sort()
    .slice(-SCORECARD_DAYS)
    .map((n) => readJsonFile<unknown>(path.join(dir, n), null))
    .filter((s) => s !== null)
}

function runsDir(dir: string): string {
  return path.join(dir, 'runs')
}

function readRuns(dir: string): ImproveRun[] {
  let names: string[]
  try {
    names = fs.readdirSync(runsDir(dir))
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readJsonFile<ImproveRun | null>(path.join(runsDir(dir), n), null))
    .filter((r): r is ImproveRun => r !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function writeRun(dir: string, run: ImproveRun): void {
  fs.mkdirSync(runsDir(dir), { recursive: true })
  fs.writeFileSync(path.join(runsDir(dir), `${run.runId}.json`), JSON.stringify(run, null, 2))
}

/** The default spawner: a detached headless Claude run, stdout+stderr to the log file. */
export const spawnClaudeRun: RunSpawner = ({ ws, model, logFile }) => {
  const fd = fs.openSync(logFile, 'a')
  const win = process.platform === 'win32'
  // Windows resolves `claude` to a .cmd shim, which Node only launches through a
  // shell; the prompt is then quoted by hand. `ws` is restricted to WS_ID, so it
  // cannot carry a quote or a shell metacharacter.
  const prompt = `/improve-loop ${ws}`
  const args = [
    '-p',
    win ? `"${prompt}"` : prompt,
    '--model',
    model,
    '--allowedTools',
    RUN_ALLOWED_TOOLS.join(',')
  ]
  const child = spawn('claude', args, {
    detached: true,
    shell: win,
    windowsHide: true,
    stdio: ['ignore', fd, fd]
  })
  fs.closeSync(fd)
  child.unref()
  return { onExit: (cb) => child.on('exit', (code) => cb(code)) }
}

type Handler = (ctx: Ctx) => Promise<void>

interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  deps: ImproveRouteDeps
  ws: string
  cwd: string
  dir: string
  rest: string[]
}

async function getOverview({ res, deps, ws, cwd, dir }: Ctx): Promise<void> {
  let config: unknown = null
  let configError: unknown = null
  try {
    config = loadImproveConfig(cwd)
  } catch (err) {
    if (!(err instanceof ImproveConfigError)) throw err
    configError = err.errors
  }
  const workspace = await deps.svc.getWorkspace(ws)
  const tag = proposalTag(ws)
  const inbox = workspace ? await deps.svc.findInbox({ projectId: workspace.projectId }) : []
  const proposals = inbox.filter((i) => i.status === 'raw' && i.content.startsWith(tag))
  sendJson(res, 200, {
    config,
    configError,
    scorecards: readScorecards(dir),
    runs: readRuns(dir),
    rejected: readJsonFile<RejectedIdea[]>(path.join(dir, 'rejected.json'), []),
    proposals
  })
}

async function putConfig({ req, res, cwd }: Ctx): Promise<void> {
  const body = await readJson(req)
  if (!body.ok) return sendJson(res, 400, { error: 'body must be JSON under 256 KB', field: '' })
  const result = validateImproveConfig(body.value)
  if (!result.ok) {
    const [first] = result.errors
    return sendJson(res, 400, { error: first.message, field: first.field, errors: result.errors })
  }
  sendJson(res, 200, { config: saveImproveConfig(cwd, result.config) })
}

async function postRun({ res, deps, ws, cwd, dir }: Ctx): Promise<void> {
  const running = activeRuns.get(ws)
  if (running) return sendJson(res, 409, { error: 'a run is already in progress', runId: running })
  let model = 'sonnet'
  try {
    model = loadImproveConfig(cwd)?.model ?? model
  } catch {
    // An invalid config still runs; the skill reports the config problem itself.
  }
  const runId = randomUUID()
  fs.mkdirSync(runsDir(dir), { recursive: true })
  const run: ImproveRun = {
    runId,
    ws,
    startedAt: (deps.now?.() ?? new Date()).toISOString(),
    endedAt: null,
    exitCode: null
  }
  writeRun(dir, run)
  activeRuns.set(ws, runId)
  const logFile = path.join(runsDir(dir), `${runId}.log`)
  try {
    const handle = (deps.spawnRun ?? spawnClaudeRun)({ ws, model, logFile })
    handle.onExit((code) => {
      activeRuns.delete(ws)
      writeRun(dir, { ...run, endedAt: new Date().toISOString(), exitCode: code })
    })
  } catch (err) {
    activeRuns.delete(ws)
    writeRun(dir, { ...run, endedAt: new Date().toISOString(), exitCode: -1 })
    return sendJson(res, 500, { error: `could not start the run: ${(err as Error).message}` })
  }
  sendJson(res, 202, { runId })
}

async function getRun({ res, dir, rest }: Ctx): Promise<void> {
  const runId = rest[1]
  if (!runId || !WS_ID.test(runId)) return sendJson(res, 400, { error: 'invalid run id' })
  const run = readJsonFile<ImproveRun | null>(path.join(runsDir(dir), `${runId}.json`), null)
  if (!run) return sendJson(res, 404, { error: `unknown run: ${runId}` })
  let log = ''
  try {
    const buf = fs.readFileSync(path.join(runsDir(dir), `${runId}.log`))
    log = buf.subarray(Math.max(0, buf.length - MAX_LOG_BYTES)).toString('utf8')
  } catch {
    // No output yet.
  }
  sendJson(res, 200, { ...run, log })
}

async function postProposal({ req, res, deps, ws, dir, rest }: Ctx): Promise<void> {
  const [, inboxId, action] = rest
  const tag = proposalTag(ws)
  const workspace = await deps.svc.getWorkspace(ws)
  const items = workspace ? await deps.svc.findInbox({ projectId: workspace.projectId }) : []
  const item = items.find((i) => i.id === inboxId)
  if (!item || !item.content.startsWith(tag)) {
    return sendJson(res, 404, { error: `no ${tag} proposal ${inboxId}` })
  }
  if (item.status !== 'raw') {
    return sendJson(res, 409, { error: `proposal ${inboxId} is already ${item.status}` })
  }

  if (action === 'approve') {
    const firstLine = item.content.slice(tag.length).trim().split(/\r?\n/)[0] ?? ''
    const result = await deps.svc.convertInboxToTask(inboxId, {
      title: firstLine.slice(0, 200) || `Improve proposal ${inboxId}`,
      labels: ['improve-loop'],
      body: proposalTaskBody(ws, inboxId, item.content)
    })
    return sendJson(res, 200, { inboxId, taskId: result.taskId })
  }

  const body = await readJson(req)
  const reason =
    body.ok && typeof (body.value as { reason?: unknown }).reason === 'string'
      ? ((body.value as { reason: string }).reason ?? '').trim()
      : ''
  if (!reason) return sendJson(res, 400, { error: 'reason is required', field: 'reason' })
  const file = path.join(dir, 'rejected.json')
  const rejected = readJsonFile<RejectedIdea[]>(file, [])
  rejected.push({
    inboxId,
    reason,
    at: (deps.now?.() ?? new Date()).toISOString(),
    content: item.content
  })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(rejected, null, 2) + '\n')
  await deps.svc.archiveInbox(inboxId, `rejected: ${reason}`)
  sendJson(res, 200, { inboxId, rejected: rejected.length })
}

async function getScreenshot({ req, res, dir }: Ctx): Promise<void> {
  const raw = (req.url ?? '/').split('?')[0]
  const marker = '/screenshots/'
  const rel = decodeURIComponent(raw.slice(raw.indexOf(marker) + marker.length))
  const file = PNG.test(rel) ? safeResolve(dir, rel) : null
  if (!file) return sendJson(res, 400, { error: 'invalid screenshot path' })
  let bytes: Buffer
  try {
    bytes = fs.readFileSync(file)
  } catch {
    return sendJson(res, 404, { error: 'no such screenshot' })
  }
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) })
  res.end(bytes)
}

/**
 * Converting needs the task template (inbox_convert refuses anything else). The
 * skill writes checkable AC into the proposal (TASK-2358); those `- [ ]` lines
 * become the task's Acceptance, and a proposal without any gets one that the
 * next measure run can answer.
 */
export function proposalTaskBody(ws: string, inboxId: string, content: string): string {
  const acs = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- [ ]'))
  const acceptance = acs.length
    ? acs
    : ['- [ ] The targeted criterion improves on the next `choda-deck improve measure` run']
  return [
    '## Context',
    content.trim(),
    '',
    '## Acceptance',
    ...acceptance,
    '',
    '## Test Plan',
    `Run \`choda-deck improve measure ${ws}\` after the change and compare the criterion with the previous scorecard.`,
    '',
    '## Related',
    `Improve loop (TASK-2352) proposal ${inboxId}, workspace ${ws}.`,
    ''
  ].join('\n')
}

function pickHandler(method: string, rest: string[]): Handler | null {
  const [head, , action] = rest
  if (rest.length === 0) return method === 'GET' ? getOverview : null
  if (head === 'config' && rest.length === 1) return method === 'PUT' ? putConfig : null
  if (head === 'run' && rest.length === 1) return method === 'POST' ? postRun : null
  if (head === 'runs' && rest.length === 2) return method === 'GET' ? getRun : null
  if (head === 'screenshots' && rest.length >= 2) return method === 'GET' ? getScreenshot : null
  if (head === 'proposals' && rest.length === 3 && (action === 'approve' || action === 'reject')) {
    return method === 'POST' ? postProposal : null
  }
  return null
}

/** Returns true when it handled the request. */
export async function handleImproveRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ImproveRouteDeps
): Promise<boolean> {
  const raw = (req.url ?? '/').split('?')[0]
  if (!raw.startsWith(PREFIX)) return false
  if (!tokenMatches(req.headers['x-choda-bridge-token'] as string | undefined, deps.bridgeToken)) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }
  const [ws, ...rest] = raw.slice(PREFIX.length).split('/')
  if (!ws || !WS_ID.test(ws)) {
    sendJson(res, 400, { error: 'invalid workspace id' })
    return true
  }
  const handler = pickHandler(req.method ?? 'GET', rest)
  if (!handler) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  if (!deps.artifactsDir) {
    sendJson(res, 503, { error: 'no artifacts dir configured' })
    return true
  }
  const workspace = await deps.svc.getWorkspace(ws)
  if (!workspace) {
    sendJson(res, 404, { error: `unknown workspace: ${ws}` })
    return true
  }
  if (!fs.existsSync(workspace.cwd)) {
    sendJson(res, 409, { error: 'workspace cwd does not exist', cwd: workspace.cwd })
    return true
  }
  try {
    await handler({
      req,
      res,
      deps,
      ws,
      cwd: workspace.cwd,
      dir: improveDir(deps.artifactsDir, ws),
      rest
    })
  } catch (err) {
    // A failed write or a refused convert must still answer: an unanswered
    // request just hangs the view's spinner.
    const code = (err as { code?: unknown }).code
    if (!res.headersSent) {
      sendJson(res, typeof code === 'string' ? 422 : 500, {
        error: (err as Error).message,
        code: typeof code === 'string' ? code : undefined
      })
    }
  }
  return true
}
