// TASK-1874 — creating a container. The argv IS the security boundary, so it is
// asserted whole; every rejection asserts that NOTHING was spawned.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { handleDockerRunRoute, runArgv } from './docker-run'
import type { DockerReader } from './docker-containers'
import type { DockerSpawner, SpawnResult } from './docker-actions'

const TOKEN = 'run-token'

const IMAGES = [
  ['img111', 'postgres', '16', '420MB', '2026-09-04'].join('\t'),
  ['img222', 'redis', '7', '40MB', '2026-09-04'].join('\t')
].join('\n')

let PS = 'c1\texisting-one\trunning\tUp 3h\tpostgres:16\t\t'

let spawns: { args: string[]; deadlineMs: number }[] = []
let available = true
let spawnImpl: () => Promise<SpawnResult>

const reader: DockerReader = {
  available: () => available,
  ps: () => PS,
  logs: () => '',
  images: () => IMAGES
}

const spawner: DockerSpawner = (args, deadlineMs) => {
  spawns.push({ args, deadlineMs })
  return spawnImpl()
}

const exits = (code: number, stdout = 'deadbeef1234\n'): Promise<SpawnResult> =>
  Promise.resolve({ code, timedOut: false, tookMs: 300, stdout })

let server: Server
let base: string

async function run(
  body: unknown,
  token: string | null = TOKEN
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/docker/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'x-choda-bridge-token': token })
    },
    body: JSON.stringify(body)
  })
  const raw = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    parsed = { raw }
  }
  return { status: res.status, body: parsed }
}

beforeEach(async () => {
  spawns = []
  available = true
  PS = 'c1\texisting-one\trunning\tUp 3h\tpostgres:16\t\t'
  spawnImpl = () => exits(0)

  server = createServer((req, res) => {
    void handleDockerRunRoute(req, res, { bridgeToken: TOKEN, reader, spawner }).then((h) => {
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

describe('AC-1 — the argv is exactly what it should be, and nothing more', () => {
  it('builds run -d --name <name> -p host:container <image>', async () => {
    await run({ imageId: 'img111', name: 'scratch-pg', ports: [{ host: 5433, container: 5432 }] })
    // Asserted WHOLE. toContain would pass with -v or --privileged appended,
    // which is the one thing this route must never do.
    expect(spawns[0].args).toEqual([
      'run',
      '-d',
      '--name',
      'scratch-pg',
      '-p',
      '5433:5432',
      'img111'
    ])
  })

  it('omits -p entirely when no ports are asked for', async () => {
    await run({ imageId: 'img222', name: 'scratch-redis' })
    expect(spawns[0].args).toEqual(['run', '-d', '--name', 'scratch-redis', 'img222'])
  })

  it('repeats -p per pair, in order, with the image last', () => {
    expect(
      runArgv('img111', 'multi', [
        { host: 1, container: 2 },
        { host: 3, container: 4 }
      ])
    ).toEqual(['run', '-d', '--name', 'multi', '-p', '1:2', '-p', '3:4', 'img111'])
  })
})

describe('AC-2 — an unknown field is refused, never ignored', () => {
  it('rejects each of the five that would widen the permission, by name', async () => {
    for (const field of ['volumes', 'privileged', 'network', 'env', 'command']) {
      const { status, body } = await run({
        imageId: 'img111',
        name: 'x',
        [field]: field === 'privileged' ? true : ['anything']
      })
      expect(status, field).toBe(400)
      expect(String(body.error), field).toContain(field)
    }
    // Ignoring an unknown field is how the largest permission in this app would
    // arrive without anyone deciding it.
    expect(spawns).toEqual([])
  })

  it('CONTROL — the three allowed fields together are accepted', async () => {
    const { status } = await run({
      imageId: 'img111',
      name: 'ok-name',
      ports: [{ host: 8080, container: 80 }]
    })
    expect(status).toBe(201)
    expect(spawns).toHaveLength(1)
  })
})

describe('AC-3 — ports are integers in range, or nothing happens', () => {
  it('rejects every bad port shape with nothing spawned', async () => {
    const bad: unknown[] = [0, 70000, -1, '80', 8080.5, null, {}]
    for (const host of bad) {
      const { status } = await run({
        imageId: 'img111',
        name: 'x',
        ports: [{ host, container: 80 }]
      })
      expect(status, JSON.stringify(host)).toBe(400)
    }
    // Refused rather than coerced: "80" becoming 80 is how a value that is not
    // a number reaches argv.
    expect(spawns).toEqual([])
  })

  it('rejects a bad CONTAINER port too, not only the host side', async () => {
    const { status } = await run({
      imageId: 'img111',
      name: 'x',
      ports: [{ host: 8080, container: 0 }]
    })
    expect(status).toBe(400)
    expect(spawns).toEqual([])
  })

  it('CONTROL — the boundary values 1 and 65535 are accepted', async () => {
    const { status } = await run({
      imageId: 'img111',
      name: 'edges',
      ports: [{ host: 1, container: 65535 }]
    })
    expect(status).toBe(201)
    expect(spawns[0].args).toContain('1:65535')
  })
})

describe('AC-4 — the name is docker-shaped, or nothing happens', () => {
  it('rejects empty, flag-like, slashed, spaced and over-long names', async () => {
    const bad = ['', '-rm', 'has/slash', 'has space', 'a'.repeat(64), '.leading-dot']
    for (const name of bad) {
      const { status } = await run({ imageId: 'img111', name })
      expect(status, JSON.stringify(name)).toBe(400)
    }
    // A name shaped like a flag is the way a string becomes an argument.
    expect(spawns).toEqual([])
  })

  it('CONTROL — a 63-character name and the legal punctuation are accepted', async () => {
    const { status } = await run({ imageId: 'img111', name: `a${'b'.repeat(62)}` })
    expect(status).toBe(201)
    const dotted = await run({ imageId: 'img111', name: 'a.b_c-d' })
    expect(dotted.status).toBe(201)
  })
})

describe('AC-5 — the image comes from the daemon, never from the request', () => {
  it('404s an unknown id and a registry reference, spawning nothing', async () => {
    expect((await run({ imageId: 'nope', name: 'x' })).status).toBe(404)
    // The important one: a reference the daemon does not hold would make docker
    // PULL it from wherever the name points.
    expect((await run({ imageId: 'evil/image:latest', name: 'x' })).status).toBe(404)
    expect(spawns).toEqual([])
  })

  it('a tag that exists as a REFERENCE but is not an id is still refused', async () => {
    // postgres:16 is a real image on this daemon, by reference. The route
    // resolves by ID, so this must not be accepted as a shortcut.
    expect((await run({ imageId: 'postgres:16', name: 'x' })).status).toBe(404)
    expect(spawns).toEqual([])
  })
})

describe('AC-7 — the state is read back, never assumed', () => {
  it('reports the state the daemon gives after the run', async () => {
    spawnImpl = () => {
      PS = 'c1\texisting-one\trunning\tUp 3h\tpostgres:16\t\t\nc9\tscratch-pg\trunning\tUp 1s\tpostgres:16\t\t'
      return exits(0)
    }
    const { status, body } = await run({ imageId: 'img111', name: 'scratch-pg' })
    expect(status).toBe(201)
    expect(body.state).toBe('running')
    // The id comes from the daemon's list, not from parsing stdout.
    expect(body.id).toBe('c9')
  })

  it('a container that exited immediately is reported as exited, not running', async () => {
    // THE discriminator. `docker run -d` exiting 0 means the container was
    // CREATED. An image whose command ends at once is already gone, and a route
    // that reported success would say "running" about something that is not.
    spawnImpl = () => {
      PS = 'c1\texisting-one\trunning\tUp 3h\tpostgres:16\t\t\nc9\tflash\texited\tExited (0) 1s ago\tredis:7\t\t'
      return exits(0)
    }
    const { body } = await run({ imageId: 'img222', name: 'flash' })
    expect(body.state).toBe('exited')
  })
})

describe('the gates this route shares with its siblings', () => {
  it('409s a name already taken, without spawning', async () => {
    const { status, body } = await run({ imageId: 'img111', name: 'existing-one' })
    expect(status).toBe(409)
    expect(body.error).toBe('name taken')
    expect(spawns).toEqual([])
  })

  it('501s with no daemon, 401s without the token, 405s a GET', async () => {
    available = false
    expect((await run({ imageId: 'img111', name: 'x' })).status).toBe(501)
    available = true
    expect((await run({ imageId: 'img111', name: 'x' }, null)).status).toBe(401)
    const res = await fetch(`${base}/docker/run`, { headers: { 'x-choda-bridge-token': TOKEN } })
    expect(res.status).toBe(405)
    expect(spawns).toEqual([])
  })

  it('a non-zero exit is 502, not 201', async () => {
    spawnImpl = () => exits(125)
    expect((await run({ imageId: 'img111', name: 'x' })).status).toBe(502)
  })
})
