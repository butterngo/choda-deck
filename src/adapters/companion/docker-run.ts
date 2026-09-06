// TASK-1874 — run a container from an image.
//
// This is the largest step the companion has taken, and the file is shaped
// around that rather than around convenience.
//
// Everything else in this app either reads, or acts on a container that ALREADY
// EXISTS with a fixed verb and a validated id. `docker run` is different in
// kind: its arguments select what the new process can reach. `-v C:\:/host`
// hands a container the whole drive.
//
// So the argv is built from an allowlist of three things — the image, a name, a
// list of port pairs — and every one of them is validated to a shape before it
// is used. Nothing else is accepted, and an unknown field is a 400 rather than
// something quietly ignored: a permissive parser is how the next permission
// arrives without anyone deciding it.
//
// Deliberately absent, each larger than the last: -v, --env, --network,
// --cap-add, --privileged. Volumes are deferred rather than refused on
// principle; the rest were not asked for.

import type { IncomingMessage, ServerResponse } from 'http'
import { execDockerReader, parsePs, type DockerReader } from './docker-containers'
import { realSpawner, type DockerSpawner } from './docker-actions'
import { parseImages } from './docker-images'

const RUN_ROUTE = '/docker/run'
/** Creating a container is fast; pulling is not, and this never pulls. */
const RUN_DEADLINE_MS = 60_000

/** Docker's own rule for a container name, applied by us before argv. */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/

/** Exactly the fields this route accepts. Anything else is a 400. */
const ALLOWED_FIELDS = new Set(['imageId', 'name', 'ports'])

export interface PortPair {
  host: number
  container: number
}

const isPort = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535

/**
 * The argv, exported so a test can assert it WHOLE rather than by substring.
 * The array is the security boundary here; `toContain` would pass with an extra
 * flag appended, which is the one thing this must not allow.
 */
export function runArgv(imageId: string, name: string, ports: PortPair[]): string[] {
  const args = ['run', '-d', '--name', name]
  for (const p of ports) args.push('-p', `${p.host}:${p.container}`)
  args.push(imageId)
  return args
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 16 * 1024) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface DockerRunOptions {
  bridgeToken: string
  reader?: DockerReader
  spawner?: DockerSpawner
}

export async function handleDockerRunRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DockerRunOptions
): Promise<boolean> {
  if (((req.url ?? '').split('?')[0] ?? '') !== RUN_ROUTE) return false

  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const raw = await readBody(req)
  if (raw === null) {
    sendJson(res, 413, { error: 'too large' })
    return true
  }
  let body: Record<string, unknown>
  try {
    body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>)
  } catch {
    sendJson(res, 400, { error: 'body is not valid JSON' })
    return true
  }

  // Exhaustive, and checked FIRST. An ignored `volumes` field is how the
  // largest permission in this app would arrive without anyone deciding it, so
  // the parser refuses what it does not know rather than dropping it.
  const unknown = Object.keys(body).filter((k) => !ALLOWED_FIELDS.has(k))
  if (unknown.length > 0) {
    sendJson(res, 400, { error: `unsupported field: ${unknown.join(', ')}` })
    return true
  }

  const name = body.name
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    sendJson(res, 400, { error: 'name must match [a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}' })
    return true
  }

  const rawPorts = body.ports ?? []
  if (!Array.isArray(rawPorts)) {
    sendJson(res, 400, { error: 'ports must be an array' })
    return true
  }
  const ports: PortPair[] = []
  for (const p of rawPorts) {
    const pair = p as { host?: unknown; container?: unknown }
    // Integers only, and in range. A string "80" is refused rather than
    // coerced: coercion is how a value that is not a number reaches argv.
    if (!isPort(pair?.host) || !isPort(pair?.container)) {
      sendJson(res, 400, { error: 'each port must be an integer between 1 and 65535' })
      return true
    }
    ports.push({ host: pair.host, container: pair.container })
  }

  const imageId = body.imageId
  if (typeof imageId !== 'string' || imageId === '') {
    sendJson(res, 400, { error: 'imageId is required' })
    return true
  }

  const reader = opts.reader ?? execDockerReader
  if (!reader.available()) {
    sendJson(res, 501, { error: 'docker not available' })
    return true
  }

  let images: { id: string }[]
  let containers: { name: string }[]
  try {
    const psRaw = reader.ps()
    images = parseImages(reader.images(), psRaw)
    containers = parsePs(psRaw, [])
  } catch {
    sendJson(res, 502, { error: 'docker listing failed' })
    return true
  }

  // Resolved against the daemon's OWN list, never taken as a reference string.
  // This is the cheapest strong guardrail here: no pull from an arbitrary
  // registry, and no invented image name reaching argv.
  const known = images.find((i) => i.id === imageId)
  if (!known) {
    sendJson(res, 404, { error: `unknown image: ${imageId}` })
    return true
  }

  // Checked before spawning so the answer is ours and specific, rather than a
  // docker error the reader has to interpret.
  if (containers.some((c) => c.name === name)) {
    sendJson(res, 409, { error: 'name taken' })
    return true
  }

  const spawner = opts.spawner ?? realSpawner
  const r = await spawner(runArgv(known.id, name, ports), RUN_DEADLINE_MS)

  if (r.timedOut) {
    sendJson(res, 409, { error: 'still running', tookMs: r.tookMs })
    return true
  }
  if (r.code !== 0) {
    sendJson(res, 502, { error: 'docker run failed', tookMs: r.tookMs })
    return true
  }

  // Read back from the daemon. `docker run -d` exiting 0 means the container was
  // CREATED, not that it is still up — an image whose command exits immediately
  // is already gone by the time this returns, and reporting "running" because
  // the request succeeded would be the UI narrating its own intent.
  let state = ''
  let id = (r.stdout ?? '').trim().split(/\r?\n/).pop() ?? ''
  try {
    const now = parsePs(reader.ps(), []).find((c) => c.name === name)
    state = now?.state ?? ''
    if (now) id = now.id
  } catch {
    state = ''
  }

  sendJson(res, 201, { id, name, state })
  return true
}
