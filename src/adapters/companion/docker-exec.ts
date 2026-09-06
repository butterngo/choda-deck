// TASK-1875 — look inside a running container.
//
// Butter asked for `docker exec`. This is the half of it that needs no terminal:
// listing a directory and reading a file are one-shot commands.
//
//   docker exec <id> ls -la /app     -> permissions, uid, gid, size, name
//   docker exec <id> cat /app/x.json -> contents
//
// The route never takes a COMMAND from the request. It takes a PATH and runs one
// of two fixed programs against it. That is the whole difference between this
// and `docker exec` in general, which runs anything — and the containers on this
// machine carry host mounts, so anything is close to host access.
//
// The path does reach argv, deliberately: it is a path inside the container,
// which is the entire feature. There is no shell for it to escape into —
// execFile takes an array — so `;`, `&&` and `$(...)` are just characters in a
// filename and are ACCEPTED. Rejecting them would be theatre that breaks real
// filenames while preventing nothing.
//
// What must never happen is a path selecting the program or adding a flag, which
// is why a leading `-` is refused.

import type { IncomingMessage, ServerResponse } from 'http'
import { execDockerReader, parsePs, type DockerReader } from './docker-containers'
import { realSpawner, type DockerSpawner } from './docker-actions'

const LS_ROUTE = '/docker/exec/ls'
const CAT_ROUTE = '/docker/exec/cat'

const EXEC_DEADLINE_MS = 15_000
/** A file bigger than this is not something to read in a pane. */
const MAX_FILE_BYTES = 512 * 1024

export interface LsEntry {
  /** The line exactly as the container's own `ls` printed it. */
  raw: string
  name: string
  mode: string
  owner: string
  group: string
  size: string
}

/**
 * Parse one `ls -la` line, keeping the raw text whatever happens.
 *
 * busybox and GNU disagree about column widths and about whether a group column
 * is present at all. A parse that silently mismatches is worse than showing the
 * line, so both are returned and the UI can fall back.
 */
export function parseLsLine(line: string): LsEntry | null {
  const raw = line.replace(/\r$/, '')
  if (raw.trim() === '' || /^total\s/i.test(raw.trim())) return null

  const cols = raw.trim().split(/\s+/)
  // mode links owner group size ...date... name — at least 7 on both busybox
  // and GNU. Anything shorter is kept raw with the fields left blank.
  if (cols.length < 7 || !/^[dl\-bcps]/.test(cols[0] ?? '')) {
    return { raw, name: raw.trim(), mode: '', owner: '', group: '', size: '' }
  }
  return {
    raw,
    mode: cols[0] ?? '',
    owner: cols[2] ?? '',
    group: cols[3] ?? '',
    size: cols[4] ?? '',
    // The name can hold spaces, so it is everything after the date columns
    // rather than the last token.
    name: cols.slice(8).join(' ') || (cols[cols.length - 1] ?? '')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface DockerExecOptions {
  bridgeToken: string
  reader?: DockerReader
  spawner?: DockerSpawner
}

export async function handleDockerExecRoute(
  req: IncomingMessage,
  res: ServerResponse,
  opts: DockerExecOptions
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  const isLs = path === LS_ROUTE
  const isCat = path === CAT_ROUTE
  if (!isLs && !isCat) return false

  if ((req.method ?? 'GET') !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const given = req.headers['x-choda-bridge-token']
  if (typeof given !== 'string' || given !== opts.bridgeToken) {
    sendJson(res, 401, { error: 'invalid or missing x-choda-bridge-token' })
    return true
  }

  const target = url.searchParams.get('path') ?? ''
  if (target === '') {
    sendJson(res, 400, { error: 'path is required' })
    return true
  }
  // The ONE thing a path must not be able to do: become a flag. Everything else
  // — spaces, semicolons, $(...) — is a legal filename and is passed through,
  // because there is no shell to interpret it.
  if (target.startsWith('-')) {
    sendJson(res, 400, { error: 'path must not start with a dash' })
    return true
  }

  const reader = opts.reader ?? execDockerReader
  if (!reader.available()) {
    sendJson(res, 501, { error: 'docker not available' })
    return true
  }

  const id = url.searchParams.get('id') ?? ''
  let known: { id: string; state: string } | undefined
  try {
    known = parsePs(reader.ps(), []).find((c) => c.id === id)
  } catch {
    sendJson(res, 502, { error: 'docker listing failed' })
    return true
  }
  if (!known) {
    sendJson(res, 404, { error: `unknown container: ${id}` })
    return true
  }
  // Checked before spawning: exec needs a running container, and our own
  // sentence beats docker's error for a reader who can see the row says exited.
  if (known.state !== 'running') {
    sendJson(res, 409, { error: 'container is not running', state: known.state })
    return true
  }

  const spawner = opts.spawner ?? realSpawner
  const argv = isLs
    ? ['exec', known.id, 'ls', '-la', target]
    : ['exec', known.id, 'cat', target]
  const r = await spawner(argv, EXEC_DEADLINE_MS)

  if (r.timedOut) {
    sendJson(res, 409, { error: 'still running', tookMs: r.tookMs })
    return true
  }
  if (r.code !== 0) {
    // The adapter's own message. docker's stderr can carry image and mount
    // detail, and it is discarded by the spawner for that reason.
    sendJson(res, 422, { error: `no such path: ${target}` })
    return true
  }

  if (isLs) {
    const entries = r.stdout
      .split('\n')
      .map(parseLsLine)
      .filter((e): e is LsEntry => e !== null)
    sendJson(res, 200, { entries })
    return true
  }

  const bytes = Buffer.from(r.stdout, 'utf8')
  if (bytes.length > MAX_FILE_BYTES) {
    // Refused rather than truncated. A body that claims to be the file and is
    // not is worse than a refusal a reader can act on.
    sendJson(res, 413, { error: 'file too large', bytes: bytes.length })
    return true
  }
  // A NUL byte is the cheap, reliable signal that this is not text, and the
  // replacement character means a decode already went wrong upstream.
  // Rendering a binary as mojibake looks like a corrupted FILE rather than a
  // wrong request, which sends the reader to debug the wrong thing.
  //
  // Built with fromCharCode rather than an escape: a literal NUL in a source
  // file survives no round trip through tooling, and the first attempt at this
  // line put a real control character into the repo.
  const NUL = String.fromCharCode(0)
  const REPLACEMENT = String.fromCharCode(65533)
  if (r.stdout.includes(NUL) || r.stdout.includes(REPLACEMENT)) {
    sendJson(res, 415, { error: 'not text' })
    return true
  }

  sendJson(res, 200, { text: r.stdout, truncated: false })
  return true
}
