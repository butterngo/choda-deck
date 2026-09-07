// TASK-1894 — talk to the docker ENGINE, not to the docker CLI.
//
// TASK-1875 ran `docker exec <id> ls -la <path>` through the CLI. Measured on
// Butter's machine, 2026-09-07:
//
//   docker exec <id> ls -la /   -> no output, exit 0
//   docker exec <id> echo hi    -> no output, exit 0   (also -i, also -t, also
//                                  redirected to a file: zero bytes)
//   docker logs --tail 2 <id>   -> normal output
//
// That environment carries DOCKER_HOST=tcp://localhost:2375. `docker exec` has
// to HIJACK the connection to stream stdout back, and over this endpoint the
// hijack produces nothing while still exiting 0. The engine's own HTTP API on
// the SAME endpoint answers correctly, which is what this module uses.
//
// Why that matters beyond one machine: an exec that returns nothing and exits 0
// is indistinguishable, to the caller, from a command that legitimately printed
// nothing. The CLI path could not tell those apart even in principle. Here the
// exit code is read back from the engine as a separate fact from the output.

import { request as httpRequest, type IncomingMessage } from 'http'
import { platform } from 'os'

/** Where the daemon listens. A socket path, or a host and port. */
export type EngineEndpoint =
  | { kind: 'socket'; path: string }
  | { kind: 'tcp'; host: string; port: number }

const DEFAULT_TCP_PORT = 2375

/**
 * Resolve the endpoint the way the docker CLI does.
 *
 * DOCKER_HOST wins when set — it is how this machine is configured and how a
 * remote daemon is reached. Otherwise the platform default: the named pipe on
 * Windows, the unix socket everywhere else. Node's http client connects to both
 * through `socketPath`, so the two are one code path from here down.
 */
export function resolveEngineEndpoint(env: NodeJS.ProcessEnv = process.env): EngineEndpoint {
  const host = (env.DOCKER_HOST ?? '').trim()
  if (host === '') {
    return platform() === 'win32'
      ? { kind: 'socket', path: '//./pipe/docker_engine' }
      : { kind: 'socket', path: '/var/run/docker.sock' }
  }
  if (host.startsWith('unix://')) return { kind: 'socket', path: host.slice('unix://'.length) }
  if (host.startsWith('npipe://')) return { kind: 'socket', path: host.slice('npipe://'.length) }
  const tcp = host.replace(/^(tcp|http|https):\/\//, '')
  const at = tcp.lastIndexOf(':')
  // No port is not an error to refuse — the CLI defaults it, and refusing here
  // would turn a working configuration into an unreadable pane.
  if (at === -1) return { kind: 'tcp', host: tcp, port: DEFAULT_TCP_PORT }
  const port = Number(tcp.slice(at + 1))
  return {
    kind: 'tcp',
    host: tcp.slice(0, at),
    port: Number.isFinite(port) && port > 0 ? port : DEFAULT_TCP_PORT
  }
}

export interface EngineResponse {
  status: number
  /** Raw bytes. Exec output is framed, so it cannot be decoded before demuxing. */
  body: Buffer
}

/** The daemon could not be reached, or did not answer in time. */
export class EngineUnreachable extends Error {
  constructor(readonly why: string) {
    super(`docker engine unreachable: ${why}`)
    this.name = 'EngineUnreachable'
  }
}

export interface EngineCall {
  method: 'GET' | 'POST'
  path: string
  json?: unknown
  deadlineMs: number
  /** Stop reading past this many bytes. The caller decides what that means. */
  maxBytes: number
}

export type EngineClient = (endpoint: EngineEndpoint, call: EngineCall) => Promise<EngineResponse>

/**
 * One request to the daemon.
 *
 * Bounded on both axes the CLI path was bounded on: a deadline, and a byte cap.
 * A container can `cat` a 4 GB file, and an unbounded read of that is the
 * adapter running out of memory rather than answering 413.
 */
export const httpEngineClient: EngineClient = (endpoint, call) =>
  new Promise<EngineResponse>((resolve, reject) => {
    const payload = call.json === undefined ? undefined : Buffer.from(JSON.stringify(call.json))
    const req = httpRequest(
      {
        ...(endpoint.kind === 'socket'
          ? { socketPath: endpoint.path }
          : { host: endpoint.host, port: endpoint.port }),
        method: call.method,
        path: call.path,
        headers: {
          host: 'docker',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(payload.length) })
        }
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          if (size >= call.maxBytes) return
          size += c.length
          chunks.push(c)
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        })
        res.on('error', (e: Error) => reject(new EngineUnreachable(e.message)))
      }
    )
    const timer = setTimeout(() => {
      req.destroy()
      reject(new EngineUnreachable('timed out'))
    }, call.deadlineMs)
    req.on('close', () => clearTimeout(timer))
    req.on('error', (e: Error) => reject(new EngineUnreachable(e.message)))
    if (payload !== undefined) req.write(payload)
    req.end()
  })

/**
 * Split the engine's multiplexed stream into stdout and stderr.
 *
 * Each frame is an 8-byte header — stream byte, three zeros, then a big-endian
 * length — followed by that many payload bytes. Concatenating the whole body as
 * text puts those header bytes INSIDE the output, which for `ls` means a
 * corrupted first filename on every frame boundary, and interleaves anything the
 * command wrote to stderr into the middle of a line.
 */
export function demux(body: Buffer): { stdout: string; stderr: string } {
  // A header, not just eight bytes: the stream byte is 0, 1 or 2, the next three
  // are zero, and the declared length fits in what is left. Without this check
  // ordinary text parses as a frame — "raw output" reads its length from the
  // bytes of the word itself and returns two characters.
  const isHeader = (at: number): boolean =>
    at + 8 <= body.length &&
    body[at] <= 2 &&
    body[at + 1] === 0 &&
    body[at + 2] === 0 &&
    body[at + 3] === 0 &&
    at + 8 + body.readUInt32BE(at + 4) <= body.length

  if (!isHeader(0)) {
    // Not multiplexed. A TTY exec sends the payload raw, and returning the body
    // is better than returning nothing — the caller's own checks still decide
    // whether it is usable.
    return { stdout: body.toString('utf8'), stderr: '' }
  }

  const out: Buffer[] = []
  const err: Buffer[] = []
  let at = 0
  while (isHeader(at)) {
    const stream = body[at]
    const len = body.readUInt32BE(at + 4)
    const frame = body.subarray(at + 8, at + 8 + len)
    if (stream === 2) err.push(frame)
    else out.push(frame)
    at += 8 + len
    // A zero-length frame advances nothing; without this a malformed tail spins.
    if (len === 0) break
  }
  return {
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8')
  }
}

export interface ExecResult {
  stdout: string
  stderr: string
  /** From the engine, read back after the stream closed. Null when unknown. */
  exitCode: number | null
}

/** Runs one fixed command inside one container. The seam every test injects. */
export type ContainerExec = (
  containerId: string,
  argv: string[],
  opts: { deadlineMs: number; maxBytes: number }
) => Promise<ExecResult>

const jsonOf = (res: EngineResponse): Record<string, unknown> => {
  try {
    return JSON.parse(res.body.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * create -> start -> inspect. Three calls, because the engine gives the output
 * and the exit code in two different answers and this route needs both.
 */
export function engineExec(
  endpoint: EngineEndpoint = resolveEngineEndpoint(),
  client: EngineClient = httpEngineClient
): ContainerExec {
  return async (containerId, argv, opts) => {
    const created = await client(endpoint, {
      method: 'POST',
      path: `/containers/${encodeURIComponent(containerId)}/exec`,
      json: { AttachStdout: true, AttachStderr: true, Cmd: argv },
      deadlineMs: opts.deadlineMs,
      maxBytes: 64 * 1024
    })
    const execId = jsonOf(created).Id
    if (typeof execId !== 'string' || execId === '') {
      throw new EngineUnreachable(`exec create answered ${created.status}`)
    }

    const started = await client(endpoint, {
      method: 'POST',
      path: `/exec/${execId}/start`,
      json: { Detach: false, Tty: false },
      deadlineMs: opts.deadlineMs,
      maxBytes: opts.maxBytes
    })
    const { stdout, stderr } = demux(started.body)

    const inspected = await client(endpoint, {
      method: 'GET',
      path: `/exec/${execId}/json`,
      deadlineMs: opts.deadlineMs,
      maxBytes: 64 * 1024
    })
    const code = jsonOf(inspected).ExitCode
    return { stdout, stderr, exitCode: typeof code === 'number' ? code : null }
  }
}
