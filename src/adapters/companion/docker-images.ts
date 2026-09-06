// TASK-1873 — images: list them, and remove one without --force.
//
// Removing an image is not like stopping a container. Stopping is reversible —
// start it again. Removing is not: an image that is not in a registry has to be
// rebuilt, which can take tens of minutes and can fail outright if the
// Dockerfile has since changed.
//
// That asymmetry is why this file refuses `--force` outright. Docker's own
// default declines to remove an image a container depends on, and that refusal
// is exactly the line between tidying up and breaking an environment. Not
// offering the flag costs nothing: a terminal is still there for the rare case
// that needs it, and adding it later has to be a deliberate act rather than a
// character typed into an argv.
//
// The in-use check is OURS rather than the daemon's, and that is deliberate too:
// it lets the answer name WHICH container holds the image, and it means the
// refusal cannot be lost by someone appending a flag.

import type { IncomingMessage, ServerResponse } from 'http'
import { execDockerReader, parsePs, type DockerReader } from './docker-containers'
import { realSpawner, type DockerSpawner } from './docker-actions'

const IMAGES_ROUTE = '/docker/images'
const PRUNE_ROUTE = '/docker/images/prune'
const IMAGE_ID_ROUTE = /^\/docker\/images\/([^/]+)$/

/** A removal is fast; prune can walk a lot of layers. */
const REMOVE_DEADLINE_MS = 30_000
const PRUNE_DEADLINE_MS = 120_000

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  createdAt: string
  /** Names of containers that depend on this image. Empty means removable. */
  inUseBy: string[]
}

/**
 * Does a container's image reference point at this image?
 *
 * Measured on the real daemon: `docker ps --format {{.Image}}` reports a
 * REFERENCE, not an id — `postgres:16`, or `newjuvenismaxime-jm-api` with the
 * `:latest` left implicit, or `ghcr.io/sooperset/mcp-atlassian:latest` with a
 * registry host. An id comparison would match none of them, and a bare
 * repository comparison would miss the tagged ones.
 *
 * A container can also report a raw id when its image was untagged after it was
 * created, which is why the id prefix is checked too.
 */
export function imageMatchesRef(img: { id: string; repository: string; tag: string }, ref: string): boolean {
  if (ref === '') return false
  if (img.id.startsWith(ref) || ref.startsWith(img.id)) return true
  const full = `${img.repository}:${img.tag}`
  if (ref === full) return true
  // `postgres` means `postgres:latest`, and only then.
  return img.tag === 'latest' && ref === img.repository
}

export function parseImages(raw: string, psRaw: string): DockerImage[] {
  const containers = parsePs(psRaw, [])
  const byRef = containers.map((c) => ({ name: c.name, ref: c.image }))

  const out: DockerImage[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [id, repository, tag, size, createdAt] = line.split('\t')
    if (id === undefined) continue
    const img = {
      id,
      repository: repository ?? '<none>',
      tag: tag ?? '<none>',
      size: size ?? '',
      createdAt: createdAt ?? ''
    }
    out.push({
      ...img,
      // Untagged images are listed, deliberately: they are the ones a reader is
      // most likely to want gone, and omitting them would hide the whole point.
      inUseBy: byRef.filter((c) => imageMatchesRef(img, c.ref)).map((c) => c.name)
    })
  }
  return out
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** `Total reclaimed space: 1.2GB` — the only place docker reports it. */
export function reclaimedFrom(stdout: string): string {
  const m = /Total reclaimed space:\s*(.+)/i.exec(stdout)
  return m?.[1]?.trim() ?? '0B'
}

/** How many `Deleted:` / `untagged:` lines a prune wrote. */
export function removedCountFrom(stdout: string): number {
  return stdout.split(/\r?\n/).filter((l) => /^deleted:|^untagged:/i.test(l.trim())).length
}

export interface DockerImageOptions {
  bridgeToken: string
  reader?: DockerReader
  spawner?: DockerSpawner
}

export async function handleDockerImageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DockerImageOptions
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  const idMatch = IMAGE_ID_ROUTE.exec(path)
  const isList = path === IMAGES_ROUTE
  const isPrune = path === PRUNE_ROUTE
  if (!isList && !isPrune && idMatch === null) return false

  const method = req.method ?? 'GET'
  const allowed =
    (isList && method === 'GET') ||
    (isPrune && method === 'POST') ||
    (idMatch !== null && !isPrune && method === 'DELETE')
  if (!allowed) {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const reader = opts.reader ?? execDockerReader
  if (!reader.available()) {
    sendJson(res, 501, { error: 'docker not available' })
    return true
  }

  let images: DockerImage[]
  try {
    images = parseImages(reader.images(), reader.ps())
  } catch {
    sendJson(res, 502, { error: 'docker listing failed' })
    return true
  }

  if (isList) {
    sendJson(res, 200, { images })
    return true
  }

  const spawner = opts.spawner ?? realSpawner

  if (isPrune) {
    const r = await spawner(['image', 'prune', '-f'], PRUNE_DEADLINE_MS)
    if (r.timedOut) {
      sendJson(res, 409, { error: 'prune still running', tookMs: r.tookMs })
      return true
    }
    if (r.code !== 0) {
      sendJson(res, 502, { error: 'docker prune failed' })
      return true
    }
    // Reported explicitly, including zero. A silent success is
    // indistinguishable from a prune that found nothing to do.
    sendJson(res, 200, {
      removed: removedCountFrom(r.stdout),
      freed: reclaimedFrom(r.stdout)
    })
    return true
  }

  const rawId = decodeURIComponent(idMatch?.[1] ?? '')
  // Resolved against what the DAEMON reported before any argv is built — the
  // same rule as container ids in TASK-1865 AC-7.
  const known = images.find((i) => i.id === rawId)
  if (!known) {
    sendJson(res, 404, { error: `unknown image: ${rawId}` })
    return true
  }

  if (known.inUseBy.length > 0) {
    // Refused HERE, before spawning anything. Letting the daemon refuse would
    // work today and would mean that adding --force later silently removes the
    // guard as well as the error.
    sendJson(res, 409, { error: 'in use', by: known.inUseBy })
    return true
  }

  // No -f, no --force. The argv is asserted whole by a test for that reason.
  const r = await spawner(['rmi', known.id], REMOVE_DEADLINE_MS)
  if (r.timedOut) {
    sendJson(res, 409, { error: 'still running', tookMs: r.tookMs })
    return true
  }
  if (r.code !== 0) {
    sendJson(res, 502, { error: 'docker rmi failed', tookMs: r.tookMs })
    return true
  }
  sendJson(res, 200, { id: known.id, freed: known.size })
  return true
}
