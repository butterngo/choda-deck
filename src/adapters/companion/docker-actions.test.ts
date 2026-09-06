// TASK-1866 — start, stop, restart. Every test injects a spawner; none touches
// a daemon, and none of them actually waits 10 seconds for anything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import {
  argvFor,
  handleDockerActionRoute,
  type DockerSpawner,
  type SpawnResult
} from './docker-actions'
import type { DockerReader } from './docker-containers'

const TOKEN = 'docker-action-token'

const PS = ['abc123\tjm-api\trunning\tUp 3 hours\tjm:latest\tp\tC:\\dev\\x'].join('\n')
const PS_STOPPED = ['abc123\tjm-api\texited\tExited (0) 1 second ago\tjm:latest\tp\tC:\\dev\\x'].join('\n')

let spawns: { args: string[]; deadlineMs: number }[] = []
let available = true
let psOutput: string
let spawnImpl: (args: string[], deadlineMs: number) => Promise<SpawnResult>

const reader: DockerReader = {
  available: () => available,
  ps: () => psOutput,
  logs: () => '',
  images: () => ''
}

const spawner: DockerSpawner = (args, deadlineMs) => {
  spawns.push({ args, deadlineMs })
  return spawnImpl(args, deadlineMs)
}

const exits = (code: number, tookMs = 50, stdout = ''): Promise<SpawnResult> =>
  Promise.resolve({ code, timedOut: false, tookMs, stdout })

let server: Server
let base: string

async function act(
  id: string,
  action: string,
  body?: Record<string, unknown>,
  token: string | null = TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/docker/containers/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-choda-bridge-token': token })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const raw = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return { status: res.status, body: parsed }
}

beforeEach(async () => {
  spawns = []
  available = true
  psOutput = PS
  spawnImpl = () => exits(0)

  server = createServer((req, res) => {
    void handleDockerActionRoute(req, res, { bridgeToken: TOKEN, reader, spawner }).then((h) => {
      if (!h) {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

// ---------------------------------------------------------------------------

describe('AC-1 — the timeout is a flag, and it reaches argv', () => {
  it('puts -t 1 in the argv when asked for 1', async () => {
    await act('abc123', 'stop', { timeoutSeconds: 1 })
    // Measured: this is the difference between 1415 ms and 10627 ms. Omitting it
    // is not a style slip, it is a ten-second wait the reader did not ask for.
    expect(spawns[0].args).toEqual(['stop', '-t', '1', 'abc123'])
  })

  it('defaults to 10 when nothing is asked', async () => {
    await act('abc123', 'stop')
    expect(spawns[0].args).toEqual(['stop', '-t', '10', 'abc123'])
  })

  it('start takes no -t, because there is nothing to wait for', async () => {
    await act('abc123', 'start')
    // docker start rejects -t; passing one would be a flag we invented.
    expect(spawns[0].args).toEqual(['start', 'abc123'])
    expect(argvFor('start', 'x', 5)).toEqual(['start', 'x'])
  })
})

describe('AC-2 — the ceiling is ours, not the child\'s', () => {
  it('409s when OUR timer fires, without waiting for the process', async () => {
    // The child never exits. If the route waited on it, this test would hang
    // rather than fail — which is why the stub is written this way.
    spawnImpl = (_args, deadlineMs) =>
      Promise.resolve({ code: null, timedOut: true, tookMs: deadlineMs, stdout: '' })
    const { status, body } = await act('abc123', 'stop', { timeoutSeconds: 2 })
    expect(status).toBe(409)
    expect(body.error).toBe('still running')
  })

  it('the deadline is docker\'s grace PLUS our own margin', async () => {
    await act('abc123', 'stop', { timeoutSeconds: 3 })
    // 3 s is what docker is asked for; we wait 3 s + 5 s before killing it.
    // Passing the same number to both would make our timer redundant, and
    // trusting the child to honour its own flag is the failure this prevents.
    expect(spawns[0].deadlineMs).toBe(8000)
    expect(spawns[0].deadlineMs).toBeGreaterThan(3000)
  })
})

describe('AC-3 — the route does not block the adapter', () => {
  it('serves a second request while the first is still in flight', async () => {
    const order: string[] = []
    spawnImpl = (args) => {
      const slow = args.includes('stop')
      return new Promise<SpawnResult>((resolve) => {
        setTimeout(
          () => {
            order.push(slow ? 'slow' : 'fast')
            resolve({ code: 0, timedOut: false, tookMs: slow ? 60 : 1, stdout: '' })
          },
          slow ? 60 : 1
        )
      })
    }

    const slow = act('abc123', 'stop')
    const fast = act('abc123', 'start')
    await Promise.all([slow, fast])

    // With execFileSync the first call would hold the loop and the order would
    // be slow-then-fast. This is the property that made a new spawner necessary.
    expect(order).toEqual(['fast', 'slow'])
  })
})

describe('AC-4 — a timeout is validated, never coerced', () => {
  const bad: unknown[] = [0, -1, 999, 'abc', 1.5, null, {}]

  it('rejects every out-of-range or non-integer value, and spawns nothing', async () => {
    for (const t of bad) {
      const { status } = await act('abc123', 'stop', { timeoutSeconds: t })
      expect(status, `timeoutSeconds=${JSON.stringify(t)}`).toBe(400)
    }
    // Refused rather than clamped: a silent clamp hides a caller sending nonsense.
    expect(spawns).toEqual([])
  })

  it('CONTROL — a valid value is accepted, so the rejections mean something', async () => {
    const { status } = await act('abc123', 'stop', { timeoutSeconds: 60 })
    expect(status).toBe(200)
    expect(spawns).toHaveLength(1)
  })
})

describe('AC-5 — an allowlist, not a denylist', () => {
  it('refuses every action outside start/stop/restart, by name, spawning nothing', async () => {
    for (const a of ['up', 'down', 'exec', 'rm', 'kill', 'run', 'stopp', 'sto']) {
      const { status, body } = await act('abc123', a)
      expect(status, a).toBe(400)
      expect(String(body.error)).toContain(a)
    }
    // A denylist of up/down would admit exec, rm, kill and whatever is added
    // next. A prefix check would admit "stopp".
    expect(spawns).toEqual([])
  })

  it('CONTROL — all three allowed actions do spawn', async () => {
    for (const a of ['start', 'stop', 'restart']) {
      const { status } = await act('abc123', a)
      expect(status, a).toBe(200)
    }
    expect(spawns).toHaveLength(3)
  })

  it('the action is checked BEFORE the body is parsed', async () => {
    // Otherwise a malformed body on a forbidden action answers "bad JSON",
    // which tells a caller their action might have been fine.
    const res = await fetch(`${base}/docker/containers/abc123/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-choda-bridge-token': TOKEN },
      body: '{not json'
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(await res.text()).error).toContain('exec')
  })
})

describe('AC-7 — the new state is read back, never assumed', () => {
  it('reports the state the daemon gives AFTER the action', async () => {
    psOutput = PS
    spawnImpl = () => {
      // The daemon's view changes as a result of the action.
      psOutput = PS_STOPPED
      return exits(0)
    }
    const { status, body } = await act('abc123', 'stop')
    expect(status).toBe(200)
    // A route that reported "stopped" because the command exited 0 would be
    // reporting its own intent. This is read from ps after the fact.
    expect(body.state).toBe('exited')
  })

  it('a container that did NOT change state reports the truth', async () => {
    // The discriminator: exit code 0 and an unchanged state is possible, and the
    // response must say so rather than what the caller hoped.
    psOutput = PS
    spawnImpl = () => exits(0)
    const { body } = await act('abc123', 'stop')
    expect(body.state).toBe('running')
  })
})

describe('the gates this route shares with its read-only sibling', () => {
  it('404s an unknown id and spawns nothing', async () => {
    const { status } = await act('nope', 'stop')
    expect(status).toBe(404)
    expect(spawns).toEqual([])
  })

  it('an id shaped like a flag is refused, not passed through', async () => {
    const { status } = await act('--volumes-from', 'stop')
    expect(status).toBe(404)
    expect(spawns).toEqual([])
  })

  it('501s with no daemon, and never lists or spawns', async () => {
    available = false
    const { status } = await act('abc123', 'stop')
    expect(status).toBe(501)
    expect(spawns).toEqual([])
  })

  it('401s without the token, and 405s a GET', async () => {
    expect((await act('abc123', 'stop', undefined, null)).status).toBe(401)
    const res = await fetch(`${base}/docker/containers/abc123/stop`, {
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(res.status).toBe(405)
  })

  it('a non-zero exit is 502, not 200', async () => {
    spawnImpl = () => exits(1)
    const { status } = await act('abc123', 'stop')
    expect(status).toBe(502)
  })
})
