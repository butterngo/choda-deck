// TASK-1894 — the engine client that replaced `docker exec`.
//
// Nothing here reaches a daemon: the endpoint resolution is pure, the demuxer is
// pure, and engineExec takes its transport as an argument.

import { describe, it, expect } from 'vitest'
import {
  EngineUnreachable,
  demux,
  engineExec,
  resolveEngineEndpoint,
  type EngineCall,
  type EngineClient,
  type EngineEndpoint,
  type EngineResponse
} from './docker-engine'

/** One non-TTY frame: stream byte, three zeros, big-endian length, payload. */
const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(8)
  head[0] = stream
  head.writeUInt32BE(payload.length, 4)
  return Buffer.concat([head, payload])
}

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), 'utf8')

describe('AC-2 — the endpoint comes from DOCKER_HOST, or from the platform', () => {
  it('reads a tcp DOCKER_HOST, host and port apart', () => {
    // Butter's machine, verbatim. This is the configuration the CLI path could
    // not survive.
    expect(resolveEngineEndpoint({ DOCKER_HOST: 'tcp://localhost:2375' })).toEqual({
      kind: 'tcp',
      host: 'localhost',
      port: 2375
    })
  })

  it('reads a unix socket and a windows named pipe as socket paths', () => {
    expect(resolveEngineEndpoint({ DOCKER_HOST: 'unix:///var/run/docker.sock' })).toEqual({
      kind: 'socket',
      path: '/var/run/docker.sock'
    })
    expect(resolveEngineEndpoint({ DOCKER_HOST: 'npipe:////./pipe/docker_engine' })).toEqual({
      kind: 'socket',
      path: '//./pipe/docker_engine'
    })
  })

  it('falls back to the platform default when DOCKER_HOST is unset or blank', () => {
    // Asserted as a shape rather than a literal: the test runs on one platform
    // and the answer differs on the other, so pinning the string would make
    // this file pass or fail by where it ran.
    for (const env of [{}, { DOCKER_HOST: '   ' }]) {
      const e = resolveEngineEndpoint(env)
      expect(e.kind).toBe('socket')
      expect((e as { path: string }).path).toMatch(/docker[_.]?(sock|engine)/)
    }
  })

  it('defaults the port when the host carries none, rather than refusing', () => {
    expect(resolveEngineEndpoint({ DOCKER_HOST: 'tcp://10.0.0.4' })).toEqual({
      kind: 'tcp',
      host: '10.0.0.4',
      port: 2375
    })
  })
})

describe('AC-1 — the stream is demuxed, not concatenated', () => {
  it('keeps stdout out of stderr, and drops the frame headers', () => {
    const body = Buffer.concat([
      frame(1, 'total 8\n'),
      frame(2, 'ls: cannot access /x\n'),
      frame(1, 'drwxr-xr-x 2 root root 4096 app\n')
    ])
    const { stdout, stderr } = demux(body)
    expect(stdout).toBe('total 8\ndrwxr-xr-x 2 root root 4096 app\n')
    expect(stderr).toBe('ls: cannot access /x\n')
    // The header bytes are the point: concatenating the body would put a NUL
    // and a length byte inside the first filename of every frame.
    expect(stdout).not.toContain(String.fromCharCode(0))
  })

  it('reassembles a payload split across frames', () => {
    const { stdout } = demux(Buffer.concat([frame(1, 'pack'), frame(1, 'age.json')]))
    expect(stdout).toBe('package.json')
  })

  it('returns an unframed body as-is rather than as nothing', () => {
    // A TTY exec is not multiplexed. Answering "" here would be the same silent
    // empty this whole task exists to remove.
    expect(demux(Buffer.from('raw output', 'utf8'))).toEqual({
      stdout: 'raw output',
      stderr: ''
    })
  })

  it('an empty body is empty, and does not spin', () => {
    expect(demux(Buffer.alloc(0))).toEqual({ stdout: '', stderr: '' })
  })
})

describe('AC-3 — the exit code is read back as its own fact', () => {
  const endpoint: EngineEndpoint = { kind: 'tcp', host: 'h', port: 1 }

  const clientFor = (
    calls: EngineCall[],
    opts: { output: Buffer; exitCode?: unknown; createStatus?: number; createBody?: Buffer }
  ): EngineClient => {
    return (_e, call) => {
      calls.push(call)
      if (call.path.endsWith('/exec') && call.method === 'POST') {
        return Promise.resolve<EngineResponse>({
          status: opts.createStatus ?? 201,
          body: opts.createBody ?? json({ Id: 'exec-1' })
        })
      }
      if (call.path.endsWith('/start')) {
        return Promise.resolve<EngineResponse>({ status: 200, body: opts.output })
      }
      return Promise.resolve<EngineResponse>({
        status: 200,
        body: json({ ExitCode: opts.exitCode ?? 0, Running: false })
      })
    }
  }

  it('creates, starts and inspects — output and exit code from different answers', async () => {
    const calls: EngineCall[] = []
    const run = engineExec(endpoint, clientFor(calls, { output: frame(1, 'total 0\n'), exitCode: 0 }))
    const r = await run('c1', ['ls', '-la', '/app'], { deadlineMs: 1000, maxBytes: 4096 })

    expect(r).toEqual({ stdout: 'total 0\n', stderr: '', exitCode: 0 })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /containers/c1/exec',
      'POST /exec/exec-1/start',
      'GET /exec/exec-1/json'
    ])
    // The command travels in Cmd, bound to the container by the engine — no
    // shell, and no `exec` verb for a path to slip past.
    expect((calls[0].json as { Cmd: string[] }).Cmd).toEqual(['ls', '-la', '/app'])
    expect((calls[1].json as { Tty: boolean }).Tty).toBe(false)
  })

  it('carries a non-zero exit code through even when the command printed nothing', async () => {
    const run = engineExec(endpoint, clientFor([], { output: Buffer.alloc(0), exitCode: 2 }))
    const r = await run('c1', ['cat', '/nope'], { deadlineMs: 1000, maxBytes: 4096 })
    // The pair the CLI path could not produce: no output AND a code that says
    // why. Silence alone was all it had.
    expect(r.stdout).toBe('')
    expect(r.exitCode).toBe(2)
  })

  it('reports an unknown exit code as null, never as success', async () => {
    const run = engineExec(endpoint, clientFor([], { output: frame(1, 'x'), exitCode: 'nope' }))
    expect((await run('c1', ['ls'], { deadlineMs: 1000, maxBytes: 4096 })).exitCode).toBeNull()
  })

  it('a create that answers no Id is unreachable, not an empty result', async () => {
    const run = engineExec(
      endpoint,
      clientFor([], { output: Buffer.alloc(0), createStatus: 500, createBody: json({ message: 'boom' }) })
    )
    await expect(run('c1', ['ls'], { deadlineMs: 1000, maxBytes: 4096 })).rejects.toBeInstanceOf(
      EngineUnreachable
    )
  })

  it('a transport failure propagates rather than resolving empty', async () => {
    const failing: EngineClient = () => Promise.reject(new EngineUnreachable('ECONNREFUSED'))
    await expect(
      engineExec(endpoint, failing)('c1', ['ls'], { deadlineMs: 1000, maxBytes: 4096 })
    ).rejects.toBeInstanceOf(EngineUnreachable)
  })
})

describe('AC-5 — the read stays bounded', () => {
  it('passes the caller cap to the start call, not to the small ones', async () => {
    const calls: EngineCall[] = []
    const client: EngineClient = (_e, call) => {
      calls.push(call)
      if (call.path.endsWith('/exec')) return Promise.resolve({ status: 201, body: json({ Id: 'e' }) })
      if (call.path.endsWith('/start')) return Promise.resolve({ status: 200, body: frame(1, 'ok') })
      return Promise.resolve({ status: 200, body: json({ ExitCode: 0 }) })
    }
    await engineExec({ kind: 'tcp', host: 'h', port: 1 }, client)('c1', ['cat', '/x'], {
      deadlineMs: 7000,
      maxBytes: 1234
    })
    const start = calls.find((c) => c.path.endsWith('/start'))
    expect(start?.maxBytes).toBe(1234)
    expect(start?.deadlineMs).toBe(7000)
    // The create and inspect answers are small JSON; they must not be given the
    // file-sized cap.
    expect(calls.filter((c) => c.maxBytes === 1234)).toHaveLength(1)
  })
})
