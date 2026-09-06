// TASK-1865 — the container list, proven against a stubbed reader.
//
// AC-6 is the criterion this whole file is shaped by: every test here runs on a
// machine with no Docker installed. A test that needs a daemon is a test nobody
// runs on CI, and it would be exactly the test that matters least — the daemon
// is not the part that can be wrong.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleDockerRoute, parsePs, samePath, type DockerReader } from './docker-containers'

const TOKEN = 'docker-token'

const WORKSPACES = [
  { id: 'newjuvenismaxime', cwd: 'C:\\dev\\test\\NewJuvenisMaxime' },
  { id: 'choda-deck', cwd: 'C:\\dev\\choda-deck' }
]

/** Shaped exactly like the real `--format` output: seven tab-separated fields. */
const row = (
  id: string,
  name: string,
  state: string,
  status: string,
  image: string,
  project = '',
  workdir = ''
): string => [id, name, state, status, image, project, workdir].join('\t')

const PS_OUTPUT = [
  row('aaa1', 'jm-api', 'running', 'Up 45 hours (healthy)', 'jm-api:latest', 'newjuvenismaxime', 'C:\\dev\\test\\NewJuvenisMaxime'),
  // Same project, but the label uses forward slashes and a lowercase drive —
  // which is what Docker actually emits on this machine.
  row('aaa2', 'jm-db', 'running', 'Up 3 days', 'mysql:8', 'newjuvenismaxime', 'c:/dev/test/NewJuvenisMaxime'),
  // Started by `docker run`: no labels at all. 8 of 12 sampled look like this.
  row('bbb1', 'exciting_goodall', 'running', 'Up 13 hours', 'node:22-alpine'),
  // Exited, and it must still be listed.
  row('ccc1', 'es-poc', 'exited', 'Exited (0) 2 days ago', 'es:latest', 'search-engine-api', 'C:\\dev\\test\\search-engine-api')
].join('\n')

let calls: { fn: string; args: unknown[] }[] = []
let available = true
let psImpl: () => string
let logsImpl: (id: string, tail: number) => string

const reader: DockerReader = {
  available: () => {
    calls.push({ fn: 'available', args: [] })
    return available
  },
  ps: () => {
    calls.push({ fn: 'ps', args: [] })
    return psImpl()
  },
  // Present only to satisfy DockerReader; TASK-1873's own tests cover it.
  images: () => '',
  logs: (id, tail) => {
    calls.push({ fn: 'logs', args: [id, tail] })
    return logsImpl(id, tail)
  }
}

let server: Server
let base: string

async function get(path: string, token: string | null = TOKEN): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${base}${path}`, {
    headers: token === null ? {} : { 'x-choda-bridge-token': token }
  })
  const raw = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = {}
  }
  return { status: res.status, body, raw }
}

beforeEach(async () => {
  calls = []
  available = true
  psImpl = () => PS_OUTPUT
  logsImpl = (_id, tail) => Array.from({ length: tail }, (_, i) => `line ${i}`).join('\n')

  server = createServer((req, res) => {
    void handleDockerRoute(req, res, {
      bridgeToken: TOKEN,
      reader,
      listWorkspaces: async () => WORKSPACES
    }).then((handled) => {
      if (!handled) {
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

describe('AC-1 — every container, not just the running ones', () => {
  it('lists exited containers alongside running ones, with state and image', async () => {
    const { status, body } = await get('/docker/containers')
    expect(status).toBe(200)
    const containers = body.containers as { name: string; state: string; image: string }[]
    expect(containers).toHaveLength(4)

    const exited = containers.find((c) => c.name === 'es-poc')
    // The discriminator: a reader looking for a container is usually looking for
    // one that STOPPED. Filtering to running hides half the answer, and the
    // remaining list still looks plausible.
    expect(exited?.state).toBe('exited')
    expect(exited?.image).toBe('es:latest')
  })
})

describe('AC-2 — a label is used, and its absence is reported rather than filled in', () => {
  it('carries workingDir when the compose label exists', async () => {
    const { body } = await get('/docker/containers')
    const c = (body.containers as { name: string; project: string | null; workingDir: string | null }[])
      .find((x) => x.name === 'jm-api')
    expect(c?.project).toBe('newjuvenismaxime')
    expect(c?.workingDir).toBe('C:\\dev\\test\\NewJuvenisMaxime')
  })

  it('reports null for an unlabelled container and still lists it', async () => {
    const { body } = await get('/docker/containers')
    const c = (body.containers as { name: string; project: string | null; workingDir: string | null; workspaceId: string | null }[])
      .find((x) => x.name === 'exciting_goodall')
    // Two failures this rules out at once: dropping it (hides containers) and
    // guessing a project for it (renders a guess as a fact).
    expect(c).toBeDefined()
    expect(c?.project).toBeNull()
    expect(c?.workingDir).toBeNull()
    expect(c?.workspaceId).toBeNull()
  })
})

describe('AC-3 — the Windows path join actually joins', () => {
  it('matches across drive-letter case AND separator direction at once', async () => {
    const { body } = await get('/docker/containers')
    const all = body.containers as { name: string; workspaceId: string | null }[]
    // jm-api's label is backslashed and upper-drive; jm-db's is forward-slashed
    // and lower-drive. BOTH must land on the same workspace — a normaliser that
    // only lowercases passes the first and fails the second.
    expect(all.find((c) => c.name === 'jm-api')?.workspaceId).toBe('newjuvenismaxime')
    expect(all.find((c) => c.name === 'jm-db')?.workspaceId).toBe('newjuvenismaxime')
  })

  it('a workingDir matching no registered workspace stays unattached', async () => {
    // CONTROL. Without it, "everything matched" would also pass against a
    // function that returns the first workspace for any input.
    const { body } = await get('/docker/containers')
    const c = (body.containers as { name: string; workspaceId: string | null }[])
      .find((x) => x.name === 'es-poc')
    expect(c?.workingDir).toBe('C:\\dev\\test\\search-engine-api')
    expect(c?.workspaceId).toBeNull()
  })

  it('samePath is symmetric about separators, case and a trailing slash', () => {
    expect(samePath('C:\\dev\\x', 'c:/dev/x')).toBe(true)
    expect(samePath('c:/dev/x/', 'C:\\dev\\x')).toBe(true)
    expect(samePath('C:\\dev\\x', 'C:\\dev\\y')).toBe(false)
    // Not a prefix match: a sibling whose name extends another must not match.
    expect(samePath('C:\\dev\\x', 'C:\\dev\\xy')).toBe(false)
  })
})

describe('AC-4 — no daemon is a capability, not a fault', () => {
  it('501s and never calls ps', async () => {
    available = false
    const { status, body, raw } = await get('/docker/containers')
    expect(status).toBe(501)
    expect(body.error).toBe('docker not available')
    expect(calls.some((c) => c.fn === 'ps')).toBe(false)
    // A 500 would read as our bug rather than an absent tool, and a stack trace
    // in the body would be the same mistake wearing more detail.
    expect(raw).not.toMatch(/at .*\(/)
  })

  it('a listing that throws is 502 with the adapter\'s own message', async () => {
    psImpl = () => {
      throw new Error('Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine')
    }
    const { status, raw } = await get('/docker/containers')
    expect(status).toBe(502)
    // The CLI's message can carry pipe paths and hostnames; forwarding it
    // verbatim is how machine detail reaches a log nobody thought was sensitive.
    expect(raw).not.toContain('npipe')
  })
})

describe('AC-5 — the log tail is capped by us, not by the caller', () => {
  it('clamps a huge tail to 1000', async () => {
    const { status, body } = await get('/docker/logs?id=aaa1&tail=99999')
    expect(status).toBe(200)
    expect((body.lines as string[]).length).toBe(1000)
    // The CLI was also ASKED for 1000 — a cap applied only after the fact still
    // lets an unbounded response cross the process boundary.
    expect(calls.find((c) => c.fn === 'logs')?.args[1]).toBe(1000)
  })

  it('honours a smaller tail', async () => {
    const { body } = await get('/docker/logs?id=aaa1&tail=5')
    expect((body.lines as string[]).length).toBe(5)
  })

  it('falls back to the default for junk', async () => {
    const { body } = await get('/docker/logs?id=aaa1&tail=abc')
    expect((body.lines as string[]).length).toBe(200)
  })
})

describe('AC-7 — the container id never reaches argv unchecked', () => {
  it('404s an unknown id and spawns nothing', async () => {
    const { status } = await get('/docker/logs?id=not-a-real-id')
    expect(status).toBe(404)
    expect(calls.some((c) => c.fn === 'logs')).toBe(false)
  })

  it('an id shaped like an argument is refused, not passed through', async () => {
    // The one way this route could have become arbitrary execution.
    const { status } = await get(`/docker/logs?id=${encodeURIComponent('--volumes-from')}`)
    expect(status).toBe(404)
    expect(calls.some((c) => c.fn === 'logs')).toBe(false)
  })

  it('CONTROL — a known id DOES reach the reader', async () => {
    // Otherwise "logs was never called" is satisfied by a route that never works.
    await get('/docker/logs?id=aaa1&tail=3')
    expect(calls.find((c) => c.fn === 'logs')?.args[0]).toBe('aaa1')
  })
})

describe('the route obeys the app\'s existing gates', () => {
  it('401s without the bridge token', async () => {
    const { status } = await get('/docker/containers', null)
    expect(status).toBe(401)
    expect(calls).toEqual([])
  })

  it('405s a POST', async () => {
    const res = await fetch(`${base}/docker/containers`, {
      method: 'POST',
      headers: { 'x-choda-bridge-token': TOKEN }
    })
    expect(res.status).toBe(405)
  })

  it('does not handle an unrelated path', async () => {
    const { status } = await get('/tasks')
    expect(status).toBe(404)
  })
})

describe('parsePs — the pure half', () => {
  it('ignores blank lines and rows with no id', () => {
    expect(parsePs('\n\n', WORKSPACES)).toEqual([])
  })

  it('survives a row with fewer fields than expected', () => {
    // A future Docker version could drop a field; the list must degrade rather
    // than throw and take the whole tab with it.
    const out = parsePs('zzz1\tlonely', WORKSPACES)
    expect(out).toHaveLength(1)
    expect(out[0].state).toBe('')
    expect(out[0].workspaceId).toBeNull()
  })
})
