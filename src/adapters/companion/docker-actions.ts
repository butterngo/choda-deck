// TASK-1866 — start, stop and restart a container.
//
// The adapter's FIRST asynchronous child process, and that is the real content
// of this file rather than "run docker".
//
// The git precedent (workspace-commits.ts) uses execFileSync. That is acceptable
// there only because each call is fast — 127 to 206 ms measured. These are not:
//
//   docker start                     309 ms
//   docker stop   (default grace)  10627 ms
//   docker stop -t 1                1415 ms
//   docker restart (default)       10736 ms
//
// The ten seconds is NOT a hang. It is the documented SIGTERM grace period, and
// it is a flag we set — `-t 1` brings it to 1.4 s. So "unbounded" was never true
// for these three subcommands, and the discovery was wrong to say so.
//
// What it does overturn is synchrony. A 1.4-second execFileSync would freeze the
// adapter's event loop for 1.4 seconds and a 10-second one would look like a
// crash, so this spawns asynchronously.
//
// And the ceiling is OURS. `-t` is passed to docker, but the adapter also runs
// its own timer and kills the child. Trusting a child to honour its own timeout
// flag is precisely the failure this exists to prevent.
//
// `up` and `down` stay out — not because they mutate, so do these, but because
// they can pull or build, which is genuinely unbounded. The boundary is *can I
// put a ceiling on it*, not *does it change something*.

import { spawn } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'
import { execDockerReader, parsePs, type DockerReader } from './docker-containers'

const ACTION_ROUTE = /^\/docker\/containers\/([^/]+)\/([^/]+)$/

/**
 * An allowlist, deliberately, and not a denylist of `up`/`down`/`exec`. A
 * denylist admits whatever subcommand someone adds next; this refuses everything
 * it was not told about.
 */
const ACTIONS = ['start', 'stop', 'restart'] as const
type Action = (typeof ACTIONS)[number]
const isAction = (v: string): v is Action => (ACTIONS as readonly string[]).includes(v)

const DEFAULT_TIMEOUT_S = 10
const MAX_TIMEOUT_S = 60
/** How long past docker's own grace we wait before killing it ourselves. */
const OUR_GRACE_MS = 5000

export interface SpawnResult {
  code: number | null
  /** True when OUR timer fired, not the child's. */
  timedOut: boolean
  tookMs: number
  /**
   * TASK-1873 — what the child wrote. `image prune` reports how much it freed
   * and there is no other way to learn it; a prune that says nothing is
   * indistinguishable from a prune that did nothing.
   */
  stdout: string
}

/** The seam tests inject through, so no test in this file needs a daemon. */
export type DockerSpawner = (args: string[], deadlineMs: number) => Promise<SpawnResult>

export const realSpawner: DockerSpawner = (args, deadlineMs) =>
  new Promise<SpawnResult>((resolve) => {
    const started = Date.now()
    // stdout is piped now, stderr still discarded: a docker error message can
    // carry pipe paths and hostnames, and the adapter answers with its own.
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let settled = false
    let out = ''
    child.stdout?.on('data', (c: Buffer) => {
      // Capped for the same reason maxBuffer exists on the sync reader.
      if (out.length < 256 * 1024) out += c.toString('utf8')
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // SIGKILL, not SIGTERM: the child was already asked politely by `-t`, and
      // this timer only fires because that did not work.
      child.kill('SIGKILL')
      resolve({ code: null, timedOut: true, tookMs: Date.now() - started, stdout: out })
    }, deadlineMs)

    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, timedOut: false, tookMs: Date.now() - started, stdout: out })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, timedOut: false, tookMs: Date.now() - started, stdout: out })
    })
  })

/**
 * The argv for one action. Exported so a test can assert the flag rather than
 * infer it from behaviour.
 *
 * `start` takes no `-t`: there is nothing to wait for, and passing one would be
 * a flag docker rejects.
 */
export function argvFor(action: Action, id: string, timeoutSeconds: number): string[] {
  return action === 'start' ? ['start', id] : [action, '-t', String(timeoutSeconds), id]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 16 * 1024) return ''
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface DockerActionOptions {
  bridgeToken: string
  reader?: DockerReader
  spawner?: DockerSpawner
}

export async function handleDockerActionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DockerActionOptions
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  const m = ACTION_ROUTE.exec(path)
  if (!m) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const rawId = decodeURIComponent(m[1] ?? '')
  const rawAction = m[2] ?? ''

  // Checked BEFORE anything else that could spawn. An action outside the
  // allowlist never reaches a process, whatever else the request carries.
  if (!isAction(rawAction)) {
    sendJson(res, 400, { error: `unknown action: ${rawAction}` })
    return true
  }

  const bodyText = await readBody(req)
  let body: { timeoutSeconds?: unknown } = {}
  if (bodyText !== '') {
    try {
      body = JSON.parse(bodyText) as typeof body
    } catch {
      sendJson(res, 400, { error: 'body is not valid JSON' })
      return true
    }
  }

  let timeoutSeconds = DEFAULT_TIMEOUT_S
  if (body.timeoutSeconds !== undefined) {
    const t = body.timeoutSeconds
    // Integer, positive, within the cap. Anything else is user input trying to
    // become a process argument, and is refused rather than clamped — a silent
    // clamp would hide a caller sending nonsense.
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_S) {
      sendJson(res, 400, { error: 'timeoutSeconds must be an integer between 1 and 60' })
      return true
    }
    timeoutSeconds = t
  }

  const reader = opts.reader ?? execDockerReader
  if (!reader.available()) {
    sendJson(res, 501, { error: 'docker not available' })
    return true
  }

  // The id is resolved against what the DAEMON reports, exactly as the read
  // routes do (TASK-1865 AC-7). Nothing from the request reaches argv unchecked.
  let known: { id: string } | undefined
  try {
    known = parsePs(reader.ps(), []).find((c) => c.id === rawId)
  } catch {
    sendJson(res, 502, { error: 'docker listing failed' })
    return true
  }
  if (!known) {
    sendJson(res, 404, { error: `unknown container: ${rawId}` })
    return true
  }

  const spawner = opts.spawner ?? realSpawner
  const result = await spawner(
    argvFor(rawAction, known.id, timeoutSeconds),
    timeoutSeconds * 1000 + OUR_GRACE_MS
  )

  if (result.timedOut) {
    sendJson(res, 409, { error: 'still running', tookMs: result.tookMs })
    return true
  }
  if (result.code !== 0) {
    sendJson(res, 502, { error: 'docker action failed', tookMs: result.tookMs })
    return true
  }

  // The new state is READ BACK from the daemon rather than assumed. A 200 means
  // the command exited 0, which is not the same as the container being in the
  // state the reader wanted — and a UI that reports its own intent instead of
  // the machine's state is the failure AC-7 exists to prevent.
  let state = ''
  try {
    state = parsePs(reader.ps(), []).find((c) => c.id === known.id)?.state ?? ''
  } catch {
    state = ''
  }

  sendJson(res, 200, { id: known.id, state, tookMs: result.tookMs })
  return true
}
