// TASK-1865 — what is running, per workspace.
//
// The adapter has executed processes since the History tab shipped:
// `workspace-commits.ts:151` calls execFileSync('git', args) behind an
// injectable reader. TASK-1840's discovery corrected the premise that it had
// never done so, and named the seven properties that make that permission safe.
// This file copies all seven rather than inventing a second policy:
//
//   fixed program name · args as an ARRAY, never a string, so no shell is
//   involved · no stdin · capped maxBuffer · behind an injectable interface ·
//   read-only subcommands only · synchronous, which is acceptable ONLY because
//   each call is bounded and fast.
//
// The last one is load-bearing and measured, not assumed. On this machine, over
// its real 25 containers:
//
//   docker ps -a          206 ms
//   docker inspect        127 ms
//   docker logs --tail    134 ms
//
// That is what makes a tab possible instead of a button. Mutating subcommands
// do NOT keep that property — `docker stop` takes 10.6 s at its default SIGTERM
// grace — which is why they live in their own task with an async spawner.

import { execFileSync } from 'child_process'
import type { IncomingMessage, ServerResponse } from 'http'

const CONTAINERS_ROUTE = '/docker/containers'
const LOGS_ROUTE = '/docker/logs'

/** A container's log tail is a read, but an unbounded one would not be. */
const MAX_TAIL = 1000
const DEFAULT_TAIL = 200

/**
 * The compose labels a container carries when `docker compose` created it.
 * `working_dir` is an absolute path, which is the whole workspace join — it
 * needs no invention. Containers started with plain `docker run` carry neither.
 */
const LABEL_PROJECT = 'com.docker.compose.project'
const LABEL_WORKDIR = 'com.docker.compose.project.working_dir'

export interface DockerContainer {
  id: string
  name: string
  state: string
  status: string
  image: string
  /** Compose project name, or null when the container was not created by compose. */
  project: string | null
  /** Absolute path from the compose label, or null. */
  workingDir: string | null
  /** The registered workspace this belongs to, or null. Never guessed. */
  workspaceId: string | null
}

/** The seam tests inject through, so the suite runs on a machine with no Docker. */
export interface DockerReader {
  /** False when the CLI is absent or the daemon is not answering. */
  available(): boolean
  /** One line per container, tab-separated, in the field order below. */
  ps(): string
  logs(id: string, tail: number): string
  /** TASK-1873 — one line per image, tab-separated, in IMAGE_FORMAT's order. */
  images(): string
}

// Tab-separated rather than JSON: `--format json` differs across Docker versions
// and this field list is explicit about what is read.
const PS_FORMAT = [
  '{{.ID}}',
  '{{.Names}}',
  '{{.State}}',
  '{{.Status}}',
  '{{.Image}}',
  `{{.Label "${LABEL_PROJECT}"}}`,
  `{{.Label "${LABEL_WORKDIR}"}}`
].join('\t')

// Measured 2026-09-06: 400 ms over this machine's 56 images, against 206 ms for
// `ps` over 25 containers. Still inside the synchronous budget, but the gap is
// why the images list is fetched when the tab opens rather than alongside
// everything else.
const IMAGE_FORMAT = ['{{.ID}}', '{{.Repository}}', '{{.Tag}}', '{{.Size}}', '{{.CreatedAt}}'].join('	')

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024
  })
}

export const execDockerReader: DockerReader = {
  available() {
    try {
      // `version` on the SERVER, not the client: a machine can have the CLI with
      // no daemon running, and that is the common case this must detect.
      docker(['version', '--format', '{{.Server.Version}}'])
      return true
    } catch {
      return false
    }
  },
  ps() {
    // -a, deliberately: a reader looking for a container is usually looking for
    // one that stopped. Listing only running ones hides half the answer.
    return docker(['ps', '-a', '--format', PS_FORMAT])
  },
  logs(id, tail) {
    return docker(['logs', '--tail', String(tail), id])
  },
  images() {
    return docker(['images', '--format', IMAGE_FORMAT])
  }
}

/**
 * Compare two absolute paths for "the same directory".
 *
 * On Windows the compose label and the registered workspace cwd routinely
 * disagree on drive-letter case and separator direction — `C:\dev\x` against
 * `c:/dev/x` — and an exact match would send almost every container on this
 * machine to Unattached. Lowercasing alone is not enough; the separators have to
 * be normalised too, which is why a test drives both differences at once.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

export function parsePs(raw: string, workspaces: { id: string; cwd: string }[]): DockerContainer[] {
  const out: DockerContainer[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [id, name, state, status, image, project, workingDir] = line.split('\t')
    if (id === undefined || name === undefined) continue

    const dir = workingDir !== undefined && workingDir !== '' ? workingDir : null
    // Never guessed. A container with no compose label cannot be attributed to a
    // workspace, and inventing one would render a guess as a fact.
    const ws = dir === null ? null : (workspaces.find((w) => samePath(w.cwd, dir))?.id ?? null)

    out.push({
      id,
      name,
      state: state ?? '',
      status: status ?? '',
      image: image ?? '',
      project: project !== undefined && project !== '' ? project : null,
      workingDir: dir,
      workspaceId: ws
    })
  }
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface DockerRouteOptions {
  bridgeToken: string
  reader?: DockerReader
  listWorkspaces: () => Promise<{ id: string; cwd: string }[]>
}

export async function handleDockerRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DockerRouteOptions
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path !== CONTAINERS_ROUTE && path !== LOGS_ROUTE) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const reader = opts.reader ?? execDockerReader
  // An absent daemon is 501, never 5xx. A machine that does no container work is
  // not a machine with a bug, and this is the same stance the Setup pane takes
  // for a model nobody configured.
  if (!reader.available()) {
    sendJson(res, 501, { error: 'docker not available' })
    return true
  }

  let containers: DockerContainer[]
  try {
    containers = parsePs(reader.ps(), await opts.listWorkspaces())
  } catch (err) {
    // The daemon answered `version` and then failed. That is a real fault, but
    // the message is the adapter's — a CLI error can carry paths and hostnames.
    sendJson(res, 502, { error: 'docker listing failed' })
    void err
    return true
  }

  if (path === CONTAINERS_ROUTE) {
    sendJson(res, 200, { containers })
    return true
  }

  const id = url.searchParams.get('id') ?? ''
  // The id is checked against what the DAEMON reported before any argv is built.
  // This is the one place this route could have become arbitrary execution:
  // without it, a request string would select a process argument.
  const known = containers.find((c) => c.id === id)
  if (!known) {
    sendJson(res, 404, { error: `unknown container: ${id}` })
    return true
  }

  const askedRaw = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL)
  const asked = Number.isFinite(askedRaw) && askedRaw > 0 ? Math.floor(askedRaw) : DEFAULT_TAIL
  // Clamped here, not merely documented: a cap the caller can exceed is not a cap.
  const tail = Math.min(asked, MAX_TAIL)

  try {
    const text = reader.logs(known.id, tail)
    const lines = text.split(/\r?\n/)
    if (lines[lines.length - 1] === '') lines.pop()
    // The CLI is asked for `tail` lines and is trusted to obey; slicing again is
    // what makes the cap ours rather than the CLI's.
    sendJson(res, 200, { lines: lines.slice(-tail) })
  } catch {
    sendJson(res, 502, { error: 'docker logs failed' })
  }
  return true
}
